import { Resolver } from "node:dns/promises";
import { createLogger } from "../security/logger.js";

const log = createLogger("dns");

export type DnsFailureCode =
  "NXDOMAIN" | "NOT_FOUND" | "NO_DATA" | "TIMEOUT" | "SERVFAIL" | "REFUSED" | "NETWORK" | "UNKNOWN";

export interface DnsFailure {
  ok: false;
  code: DnsFailureCode;
  message: string;
  transient: boolean;
}

export type DnsResult<T> = { ok: true; value: T } | DnsFailure;

export interface DnsResolver {
  resolveTxt(name: string): Promise<DnsResult<string[][]>>;
  resolveMx(name: string): Promise<DnsResult<Array<{ exchange: string; priority: number }>>>;
}

const TIMEOUT_MS = 6000;

function classify(error: unknown): DnsFailure {
  const code =
    typeof (error as NodeJS.ErrnoException)?.code === "string"
      ? ((error as NodeJS.ErrnoException).code ?? "")
      : "";
  switch (code) {
    case "ENOTFOUND":
      // Node reports ENOTFOUND for both NXDOMAIN and an existing name with no
      // records of the requested type. Do not overstate which one occurred.
      return {
        ok: false,
        code: "NOT_FOUND",
        message:
          "No records were found for this name (ENOTFOUND). This can mean a nonexistent name or no records of this type; the result is inconclusive.",
        transient: false,
      };
    case "ENODATA":
      return {
        ok: false,
        code: "NO_DATA",
        message: "No records of this type exist for the name.",
        transient: false,
      };
    case "ETIMEOUT":
    case "ETIMEDOUT":
      return { ok: false, code: "TIMEOUT", message: "The DNS query timed out.", transient: true };
    case "ESERVFAIL":
    case "SERVFAIL":
      return { ok: false, code: "SERVFAIL", message: "The DNS server returned SERVFAIL.", transient: true };
    case "EREFUSED":
    case "ECONNREFUSED":
      return { ok: false, code: "REFUSED", message: "The DNS query was refused.", transient: false };
    case "EAI_AGAIN":
    case "ENETUNREACH":
    case "EHOSTUNREACH":
      return { ok: false, code: "NETWORK", message: "The DNS resolver is unreachable.", transient: true };
    default:
      return {
        ok: false,
        code: "UNKNOWN",
        message: "The DNS query failed for an unknown reason.",
        transient: false,
      };
  }
}

function withTimeout<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`DNS query for ${name} exceeded ${TIMEOUT_MS} ms.`);
      (error as NodeJS.ErrnoException).code = "ETIMEOUT";
      reject(error);
    }, TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** System-resolver implementation. No custom DNS servers or arbitrary protocols. */
export class SystemDnsResolver implements DnsResolver {
  private readonly resolver = new Resolver({ timeout: TIMEOUT_MS, tries: 2 });

  async resolveTxt(name: string): Promise<DnsResult<string[][]>> {
    try {
      const value = await withTimeout(this.resolver.resolveTxt(name), name);
      return { ok: true, value };
    } catch (error) {
      log.debug("TXT lookup failed", { name, error });
      return classify(error);
    }
  }

  async resolveMx(name: string): Promise<DnsResult<Array<{ exchange: string; priority: number }>>> {
    try {
      const value = await withTimeout(this.resolver.resolveMx(name), name);
      return { ok: true, value };
    } catch (error) {
      log.debug("MX lookup failed", { name, error });
      return classify(error);
    }
  }
}

/** Flatten TXT chunk arrays, as permitted by RFC 7208 / DKIM. */
export function joinTxt(chunks: string[][]): string[] {
  return chunks.map((parts) => parts.join(""));
}
