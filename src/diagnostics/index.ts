import type {
  Confidence,
  DiagnosticCheck,
  DiagnosticFinding,
  DiagnosticReport,
  Severity,
} from "../shared/types.js";
import { normalizeDomain, normalizeSelector } from "../security/validation.js";
import { analyzeDkim } from "./dkim.js";
import { analyzeDmarc } from "./dmarc.js";
import { joinTxt, SystemDnsResolver, type DnsFailure, type DnsResolver } from "./dns.js";
import { analyzeSpf } from "./spf.js";

export interface DiagnosticsOptions {
  domain: string;
  dkimSelector?: string | null;
  resolver?: DnsResolver;
  now?: number;
}

const LIMITATIONS = [
  "DNS answers can be cached, split-horizon, or temporarily unavailable; re-check before changing production records.",
  "SPF analysis checks top-level syntax and DNS-lookup term count; it does not recursively evaluate include/redirect graphs.",
  "DKIM requires a selector. MailSentry does not guess selectors, and finding a DNS key does not prove that outgoing mail is signed correctly.",
  "DMARC is checked on the exact domain only; subdomains may inherit an organizational-domain policy that is not resolved here.",
  "MailSentry does not send test messages and cannot prove deliverability, inbox placement, sender reputation, or mail-server health.",
  "DNS configuration alone does not guarantee authentication; receivers apply their own policies and reputation signals.",
  "MailSentry does not check blocklists, TLS configuration, MTA-STS, BIMI, or DNSSEC.",
  "Node's DNS resolver reports ENOTFOUND for both nonexistent names and existing names with no records of the requested type, so MailSentry labels that case inconclusive instead of asserting the domain does not exist.",
];

function finding(
  input: Omit<DiagnosticFinding, "confidence"> & { confidence?: Confidence },
): DiagnosticFinding {
  return { ...input, confidence: input.confidence ?? "confirmed" };
}

function dnsFailureFinding(
  check: DiagnosticCheck,
  failure: DnsFailure,
  id: string,
  subject: string,
): DiagnosticFinding {
  const transient = failure.transient;
  const nxdomain = failure.code === "NXDOMAIN";
  const notFound = failure.code === "NOT_FOUND" || failure.code === "NO_DATA";
  return finding({
    id,
    check,
    severity: nxdomain && check === "mx" ? "critical" : "warning",
    title: `${subject} could not be checked (${failure.code})`,
    observed: failure.message,
    whyItMatters: nxdomain
      ? "The queried name does not exist. If the domain itself is misspelled or expired, all email configuration checks are affected."
      : notFound
        ? "No records of this type were returned. This can be a legitimate absence (for example, no SPF record) or a nonexistent/incorrectly named query; the resolver may not distinguish the two. It is inconclusive, not a confirmed fault."
        : transient
          ? "A transient resolver or authoritative-server fault prevents a reliable conclusion. This is inconclusive, not a confirmed misconfiguration."
          : "The DNS query failed for a non-transient reason, so no reliable conclusion can be drawn.",
    recommendation: transient
      ? "Retry in a few minutes and verify the domain and record name with a second resolver before changing configuration."
      : "Verify the domain and record name, confirm the expected record type exists, then retry.",
    confidence: "inconclusive",
  });
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2, pass: 3 };

export async function runDiagnostics(options: DiagnosticsOptions): Promise<DiagnosticReport> {
  const domain = normalizeDomain(options.domain);
  const selector = normalizeSelector(options.dkimSelector ?? "");
  const resolver = options.resolver ?? new SystemDnsResolver();
  const checkedAt = new Date(options.now ?? Date.now()).toISOString();

  const findings: DiagnosticFinding[] = [];
  const observations: Record<string, string[]> = { mx: [], spf: [], dmarc: [], dkim: [] };
  let attempted = 0;
  let failed = 0;

  // MX
  attempted += 1;
  const mxResult = await resolver.resolveMx(domain);
  if (!mxResult.ok) {
    failed += 1;
    observations["mx"] = [`lookup failed: ${mxResult.code}`];
    findings.push(dnsFailureFinding("mx", mxResult, "mx-unavailable", "MX records"));
  } else {
    const records = [...mxResult.value].sort((a, b) => a.priority - b.priority);
    observations["mx"] = records.map((record) => `${record.priority} ${record.exchange}`);
    if (records.length === 0) {
      findings.push(
        finding({
          id: "mx-missing",
          check: "mx",
          severity: "critical",
          title: "No MX records found",
          observed: "The domain has no mail-exchange records.",
          whyItMatters:
            "Without MX records, standards-compliant senders cannot deliver mail to this domain. Some legacy configurations fall back to an A record, but that is not a reliable modern setup.",
          recommendation:
            "If the domain should receive email, publish MX records pointing at your mail provider. If it should not receive email, consider an explicit null MX (RFC 7505).",
        }),
      );
    } else if (records.every((record) => record.exchange === ".")) {
      findings.push(
        finding({
          id: "mx-null",
          check: "mx",
          severity: "info",
          title: "Null MX published (domain does not accept email)",
          observed: records.map((record) => `${record.priority} ${record.exchange}`).join(", "),
          whyItMatters:
            "A null MX explicitly tells senders that this domain does not accept email. This is a valid choice for domains used only for web or sending.",
          recommendation: "No action is needed unless you intend to receive mail at this domain.",
        }),
      );
    } else {
      const realRecords = records.filter((record) => record.exchange !== ".");
      const suspicious = realRecords.filter(
        (record) =>
          record.exchange === "localhost" ||
          record.exchange.endsWith(".local") ||
          record.exchange.endsWith(".internal") ||
          /^\d{1,3}(?:\.\d{1,3}){3}$/.test(record.exchange),
      );
      if (suspicious.length > 0) {
        findings.push(
          finding({
            id: "mx-suspicious",
            check: "mx",
            severity: "warning",
            title: "Suspicious MX target",
            observed: suspicious.map((record) => record.exchange).join(", "),
            whyItMatters:
              "MX targets should be public hostnames. Private or literal-address targets are invalid for internet mail and usually indicate a broken or internal-only configuration.",
            recommendation: "Replace invalid targets with the hostnames supplied by your mail provider.",
          }),
        );
      } else {
        findings.push(
          finding({
            id: "mx-present",
            check: "mx",
            severity: "pass",
            title: "MX records published",
            observed: realRecords.map((record) => `${record.priority} ${record.exchange}`).join(", "),
            whyItMatters: "Mail exchangers give senders a destination for inbound mail.",
            recommendation: "Keep MX priorities and targets aligned with your provider's documented values.",
          }),
        );
        if (realRecords.length === 1) {
          findings.push(
            finding({
              id: "mx-single",
              check: "mx",
              severity: "info",
              title: "Single mail exchanger",
              observed: `${realRecords[0]?.exchange ?? ""} is the only MX target.`,
              whyItMatters:
                "A single target has no DNS-level redundancy. Many providers run redundant infrastructure behind one hostname, so this alone is not a fault.",
              recommendation:
                "Confirm with your provider whether additional MX targets are recommended. Do not add unrelated MX hosts.",
            }),
          );
        }
      }
    }
  }

  // SPF
  attempted += 1;
  const spfTxt = await resolver.resolveTxt(domain);
  if (!spfTxt.ok) {
    failed += 1;
    observations["spf"] = [`lookup failed: ${spfTxt.code}`];
    findings.push(dnsFailureFinding("spf", spfTxt, "spf-unavailable", "SPF record"));
  } else {
    const spf = analyzeSpf(joinTxt(spfTxt.value));
    observations["spf"] = spf.records.map((record) => record.slice(0, 450));
    if (!spf.present) {
      findings.push(
        finding({
          id: "spf-missing",
          check: "spf",
          severity: "warning",
          title: "No SPF record found",
          observed: "No TXT record beginning with v=spf1 was found at the domain apex.",
          whyItMatters:
            "SPF lets receiving servers compare the sending IP against an authorized list. Without it, receivers have less information for authentication decisions and spoofed mail is harder to distinguish.",
          recommendation:
            "Publish one SPF TXT record that includes every legitimate sending service, then end with -all (or ~all while validating). Merge existing records rather than adding a second SPF record.",
        }),
      );
    } else {
      if (spf.records.length > 1) {
        findings.push(
          finding({
            id: "spf-multiple",
            check: "spf",
            severity: "critical",
            title: "Multiple SPF records",
            observed: spf.records.map((record) => record.slice(0, 200)).join(" | "),
            whyItMatters:
              "RFC 7208 requires exactly one SPF record per domain. Multiple records cause a permanent error at receivers and make authorization unpredictable.",
            recommendation: "Merge the intended mechanisms into a single SPF record and remove the others.",
          }),
        );
      }
      if (spf.errors.length > 0) {
        findings.push(
          finding({
            id: "spf-errors",
            check: "spf",
            severity: "warning",
            title: "SPF record has syntax or policy problems",
            observed: spf.errors.join(" "),
            whyItMatters:
              "Malformed terms or an excessive DNS-lookup chain can cause SPF to return a permanent error or fail open for parts of your mail stream.",
            recommendation:
              "Fix the listed terms, keep the total DNS-lookup count at or below 10, and validate again after publishing.",
          }),
        );
      }
      if (spf.allQualifier === "+") {
        findings.push(
          finding({
            id: "spf-all-pass",
            check: "spf",
            severity: "critical",
            title: "SPF ends with +all",
            observed: spf.record?.slice(0, 300) ?? "+all",
            whyItMatters:
              "+all authorizes every sending host, which defeats the purpose of SPF and offers no protection against spoofing.",
            recommendation: "Change +all to -all after confirming every legitimate sender is included.",
          }),
        );
      } else if (spf.allQualifier === "?") {
        findings.push(
          finding({
            id: "spf-all-neutral",
            check: "spf",
            severity: "warning",
            title: "SPF ends with ?all (neutral)",
            observed: spf.record?.slice(0, 300) ?? "?all",
            whyItMatters:
              "Neutral results explicitly provide no assertion about unauthorized senders, weakening the value of the record.",
            recommendation: "Use -all where possible, or ~all during a monitored rollout.",
          }),
        );
      } else if (spf.allQualifier === "~") {
        findings.push(
          finding({
            id: "spf-all-softfail",
            check: "spf",
            severity: "info",
            title: "SPF uses a softfail (~all)",
            observed: spf.record?.slice(0, 300) ?? "~all",
            whyItMatters:
              "Softfail marks unauthorized mail as suspicious without a definitive failure. It is common during transitions but gives receivers less certainty than -all.",
            recommendation:
              "Monitor authentication results and move to -all once legitimate senders are confirmed.",
          }),
        );
      } else if (spf.allQualifier === "-") {
        findings.push(
          finding({
            id: "spf-all-fail",
            check: "spf",
            severity: "pass",
            title: "SPF uses a hard fail (-all)",
            observed: spf.record?.slice(0, 300) ?? "-all",
            whyItMatters:
              "Hard fail clearly marks unauthorized senders. Confirm all legitimate senders are included before relying on it.",
            recommendation:
              "Review sending services whenever they change, and keep the lookup count under the limit.",
          }),
        );
      } else if (spf.allQualifier === null && !spf.redirect) {
        findings.push(
          finding({
            id: "spf-no-all",
            check: "spf",
            severity: "info",
            title: "SPF has no all mechanism",
            observed: spf.record?.slice(0, 300) ?? "",
            whyItMatters: "Without all or redirect, unmatched senders receive a neutral result.",
            recommendation: "Add an explicit all mechanism that matches your intended policy.",
          }),
        );
      }

      if (spf.lookups > 10) {
        findings.push(
          finding({
            id: "spf-lookup-limit",
            check: "spf",
            severity: "warning",
            title: "SPF exceeds the DNS-lookup limit",
            observed: `${spf.lookups} top-level lookup terms were counted; nested includes can increase this.`,
            whyItMatters:
              "RFC 7208 limits an SPF evaluation to 10 DNS-lookup terms. Exceeding the limit produces a permanent error for receivers.",
            recommendation:
              "Consolidate includes and flatten provider records where supported. Re-test after each change.",
            confidence: "inconclusive",
          }),
        );
      } else if (spf.notes.some((note) => note.includes("close to the 10"))) {
        findings.push(
          finding({
            id: "spf-lookup-near-limit",
            check: "spf",
            severity: "info",
            title: "SPF is near the DNS-lookup limit",
            observed: `${spf.lookups} top-level lookup terms were counted.`,
            whyItMatters:
              "Nested includes can consume additional lookups and push the record over the RFC limit.",
            recommendation: "Keep headroom for provider changes and avoid adding unnecessary includes.",
            confidence: "inconclusive",
          }),
        );
      }
      if (spf.errors.length === 0 && spf.records.length === 1 && spf.allQualifier !== "+") {
        findings.push(
          finding({
            id: "spf-parsed",
            check: "spf",
            severity: "pass",
            title: "SPF record parsed successfully",
            observed: `${spf.lookups} top-level DNS-lookup term(s); record published.`,
            whyItMatters: "A structurally valid SPF record gives receivers a usable authorization policy.",
            recommendation: "Keep the record in sync with the services that send mail for this domain.",
          }),
        );
      }
    }
  }

  // DMARC
  attempted += 1;
  const dmarcTxt = await resolver.resolveTxt(`_dmarc.${domain}`);
  if (!dmarcTxt.ok) {
    failed += 1;
    observations["dmarc"] = [`lookup failed at _dmarc.${domain}: ${dmarcTxt.code}`];
    findings.push(dnsFailureFinding("dmarc", dmarcTxt, "dmarc-unavailable", "DMARC record"));
  } else {
    const dmarc = analyzeDmarc(joinTxt(dmarcTxt.value));
    observations["dmarc"] = dmarc.records.map((record) => record.slice(0, 500));
    if (!dmarc.present) {
      findings.push(
        finding({
          id: "dmarc-missing",
          check: "dmarc",
          severity: "warning",
          title: "No DMARC record found",
          observed: `No DMARC TXT record was found at _dmarc.${domain}.`,
          whyItMatters:
            "DMARC tells receivers what to do when SPF and DKIM do not align with the visible From domain, and optionally sends reports. Without it, receivers fall back to their own heuristics and you lose visibility.",
          recommendation:
            "Start with p=none and a rua reporting address to measure legitimate and failing traffic before moving to quarantine or reject.",
        }),
      );
    } else {
      if (dmarc.records.length > 1) {
        findings.push(
          finding({
            id: "dmarc-multiple",
            check: "dmarc",
            severity: "critical",
            title: "Multiple DMARC records",
            observed: dmarc.records.map((record) => record.slice(0, 200)).join(" | "),
            whyItMatters:
              "Receivers cannot select among multiple DMARC records, so policy enforcement becomes unreliable.",
            recommendation: "Publish exactly one DMARC record at _dmarc.<domain>.",
          }),
        );
      }
      if (dmarc.errors.length > 0) {
        findings.push(
          finding({
            id: "dmarc-errors",
            check: "dmarc",
            severity: dmarc.records.length > 1 ? "critical" : "warning",
            title: "DMARC record has validation problems",
            observed: dmarc.errors.join(" "),
            whyItMatters:
              "Invalid tags or values can cause receivers to ignore the policy or treat it as invalid.",
            recommendation: "Correct the listed tags and republish a single valid DMARC record.",
          }),
        );
      }
      if (dmarc.policy === "none") {
        findings.push(
          finding({
            id: "dmarc-policy-none",
            check: "dmarc",
            severity: "info",
            title: "DMARC is in monitoring mode (p=none)",
            observed: dmarc.record?.slice(0, 400) ?? "p=none",
            whyItMatters:
              "p=none requests reports but asks receivers not to quarantine or reject failing mail. It is the safest starting point, but it does not stop spoofing.",
            recommendation:
              "Review aggregate reports. Move to p=quarantine, then p=reject, only after all legitimate mail aligns with SPF or DKIM. Forwarded mail can break alignment, so consider pct and subdomain policy.",
          }),
        );
      } else if (dmarc.policy === "quarantine") {
        findings.push(
          finding({
            id: "dmarc-policy-quarantine",
            check: "dmarc",
            severity: "pass",
            title: "DMARC requests quarantine",
            observed: dmarc.record?.slice(0, 400) ?? "p=quarantine",
            whyItMatters:
              "Quarantine asks receivers to treat failing mail as suspicious. This blocks much spoofing while being less aggressive than rejection.",
            recommendation:
              "Monitor reports and legitimate-mail delivery. Consider p=reject only once alignment is stable across all senders.",
          }),
        );
      } else if (dmarc.policy === "reject") {
        findings.push(
          finding({
            id: "dmarc-policy-reject",
            check: "dmarc",
            severity: "pass",
            title: "DMARC requests rejection",
            observed: dmarc.record?.slice(0, 400) ?? "p=reject",
            whyItMatters:
              "Reject is the strongest DMARC policy. It can block legitimate mail that is not aligned, including some mailing lists and forwarders.",
            recommendation:
              "Keep aggregate reporting enabled and verify all legitimate senders, including third parties, remain aligned.",
          }),
        );
      }
      if (dmarc.percentage !== null && dmarc.percentage < 100) {
        findings.push(
          finding({
            id: "dmarc-partial-pct",
            check: "dmarc",
            severity: "info",
            title: `DMARC applies to ${dmarc.percentage}% of failing mail`,
            observed: `pct=${dmarc.percentage}`,
            whyItMatters:
              "The remaining percentage is not subject to the stated policy, limiting enforcement.",
            recommendation: "Raise pct to 100 only after confirming legitimate mail passes alignment.",
          }),
        );
      }
      if (!("rua" in dmarc.tags)) {
        findings.push(
          finding({
            id: "dmarc-no-rua",
            check: "dmarc",
            severity: "info",
            title: "DMARC reporting address not configured",
            observed: "The record has no rua tag.",
            whyItMatters:
              "Without aggregate reports you cannot see which legitimate or forged sources are failing DMARC.",
            recommendation:
              "Add a rua=mailto: address you control. Review report volume and privacy implications before enabling.",
          }),
        );
      }
      if (dmarc.errors.length === 0 && dmarc.records.length === 1) {
        findings.push(
          finding({
            id: "dmarc-parsed",
            check: "dmarc",
            severity: "pass",
            title: "DMARC record is structurally valid",
            observed: `Policy: ${dmarc.policy ?? "unknown"}; subdomain policy: ${dmarc.subdomainPolicy ?? "inherit"}.`,
            whyItMatters:
              "A valid DMARC record gives receivers an explicit policy and a reporting path. Policies differ: none monitors, quarantine isolates suspicious mail, and reject refuses it.",
            recommendation:
              "Keep policy aligned with actual sender authentication and review reports regularly. Stricter enforcement affects any legitimate but unauthenticated mail.",
          }),
        );
      }
    }
  }

  // DKIM
  if (!selector) {
    findings.push(
      finding({
        id: "dkim-no-selector",
        check: "dkim",
        severity: "info",
        title: "DKIM not checked: selector required",
        observed: "No DKIM selector was supplied.",
        whyItMatters:
          "DKIM keys are published at <selector>._domainkey.<domain>. MailSentry does not guess selectors, so a missing selector is not evidence that DKIM is absent or broken.",
        recommendation:
          "Find the selector in a signed message's DKIM-Signature header or in your provider's documentation, then re-run the check with that selector.",
        confidence: "inconclusive",
      }),
    );
    observations["dkim"] = ["not checked: no selector supplied"];
  } else {
    attempted += 1;
    const name = `${selector}._domainkey.${domain}`;
    const dkimTxt = await resolver.resolveTxt(name);
    if (!dkimTxt.ok) {
      failed += 1;
      observations["dkim"] = [`lookup failed at ${name}: ${dkimTxt.code}`];
      findings.push(
        finding({
          id: "dkim-unavailable",
          check: "dkim",
          severity: "warning",
          title: `DKIM selector "${selector}" could not be checked`,
          observed: `${dkimTxt.message} (${name})`,
          whyItMatters:
            "The selector may be wrong, rotated, or the DNS lookup may be transiently failing. This is not proof that DKIM is misconfigured.",
          recommendation:
            "Confirm the active selector from a recent signed message header, then retry. Check with your mail provider if the record should exist.",
          confidence: "inconclusive",
        }),
      );
    } else {
      const dkim = analyzeDkim(joinTxt(dkimTxt.value));
      observations["dkim"] = dkim.record ? [dkim.record.slice(0, 500)] : [`no TXT record at ${name}`];
      if (!dkim.present) {
        findings.push(
          finding({
            id: "dkim-missing",
            check: "dkim",
            severity: "warning",
            title: `No DKIM key found for selector "${selector}"`,
            observed: `No DKIM TXT record was found at ${name}.`,
            whyItMatters:
              "Without a published key, receivers cannot verify signatures made with this selector. The selector may be inactive, which is normal during rotation, or outbound signing may be misconfigured.",
            recommendation:
              "Verify the selector against a recent DKIM-Signature header. If the selector is current, publish the provider's DKIM key and confirm outbound signing.",
            confidence: "inconclusive",
          }),
        );
      } else if (dkim.errors.length > 0) {
        findings.push(
          finding({
            id: "dkim-invalid",
            check: "dkim",
            severity: "warning",
            title: "DKIM record has validation problems",
            observed: dkim.errors.join(" "),
            whyItMatters: "Invalid or revoked keys prevent signature verification for this selector.",
            recommendation:
              "Republish the provider-supplied DKIM key and rotate the selector if it was revoked.",
          }),
        );
      } else {
        findings.push(
          finding({
            id: "dkim-present",
            check: "dkim",
            severity: "pass",
            title: `DKIM key found for selector "${selector}"`,
            observed: `Key type: ${dkim.keyType}; public key present.`,
            whyItMatters:
              "A published key allows receivers to verify signatures for this selector. DNS presence alone does not confirm that outgoing mail is signed or that signatures verify.",
            recommendation:
              "Send a test message to a mailbox you control and inspect its DKIM-Signature result.",
          }),
        );
      }
      if (dkim.testing) {
        findings.push(
          finding({
            id: "dkim-testing",
            check: "dkim",
            severity: "info",
            title: "DKIM record is in testing mode",
            observed: "The key record contains t=y.",
            whyItMatters:
              "Testing mode tells receivers to treat signatures cautiously and should not remain in production indefinitely.",
            recommendation: "Remove t=y once the signing configuration is verified.",
          }),
        );
      }
    }
  }

  const status: DiagnosticReport["status"] =
    attempted > 0 && failed === attempted ? "failed" : failed > 0 ? "partial" : "ok";

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    domain,
    checkedAt,
    dkimSelector: selector || null,
    status,
    findings,
    observations,
    limitations: LIMITATIONS,
  };
}
