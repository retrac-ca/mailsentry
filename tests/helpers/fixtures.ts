import type { DnsResolver, DnsResult } from "../../src/diagnostics/dns.js";
import type { AppConfig } from "../../src/core/config.js";
import type {
  CleanupAction,
  CleanupFilters,
  FolderKind,
  MessageMetadata,
  ProviderId,
} from "../../src/shared/types.js";
import { PlanStore, type PlanEntry } from "../../src/core/plan.js";
import { SyntheticProvider, syntheticMessage } from "../../src/providers/synthetic.js";

export const NOW = Date.parse("2026-10-28T12:00:00.000Z");

export const BASE_FILTERS: CleanupFilters = {
  minAgeDays: 365,
  minSizeBytes: null,
  largeAttachmentBytes: null,
  bulkOnly: false,
  senderAllowlist: [],
  senderTargets: [],
  includeStarred: false,
  includeUnread: false,
  includeImportant: false,
};

export function makeMessages(count: number, folder: FolderKind = "inbox"): MessageMetadata[] {
  return Array.from({ length: count }, (_value, index) =>
    syntheticMessage(`${folder}-${index}`, {
      folder,
      receivedAt: new Date(NOW - (400 + index) * 86_400_000).toISOString(),
      sizeBytes: 10_000 + index * 100,
    }),
  );
}

export function makePlan(
  options: {
    provider?: ProviderId;
    folders?: FolderKind[];
    action?: CleanupAction;
    filters?: CleanupFilters;
    entries?: PlanEntry[];
    ttlMs?: number;
    previewSample?: number;
  } = {},
) {
  const provider = options.provider ?? "microsoft";
  const folders = options.folders ?? ["inbox"];
  const action = options.action ?? "trash";
  const filters = options.filters ?? BASE_FILTERS;
  const entries = options.entries ?? [{ id: "inbox-0", folder: "inbox" as FolderKind }];
  const store = new PlanStore(options.ttlMs ?? 60_000);
  const preview = store.create(
    {
      sessionId: "test-session",
      connectionToken: "test-connection",
      provider,
      folders,
      filters,
      action,
      entries,
      scannedCount: entries.length,
      eligibleBytes: entries.length * 10_000,
      uncertainCount: 0,
      byFolder: folders.map((folder) => ({
        folder,
        displayName: folder,
        scanned: entries.filter((entry) => entry.folder === folder).length,
        eligible: entries.filter((entry) => entry.folder === folder).length,
        uncertain: 0,
        bytes: 0,
      })),
      sample: entries.slice(0, options.previewSample ?? 10).map((entry) => ({
        id: entry.id,
        folder: entry.folder,
        subject: null,
        from: null,
        receivedAt: new Date(NOW).toISOString(),
        sizeBytes: 10_000,
        bulk: { level: "none" as const, evidence: null },
        uncertain: false,
      })),
      sampleTruncated: false,
      warnings: [],
      limitations: [],
      ttlMs: options.ttlMs ?? 60_000,
    },
    NOW,
  );
  const plan = store.get(preview.planId, NOW);
  if (!plan) throw new Error("plan was not stored");
  return { store, preview, plan };
}

export class FakeDnsResolver implements DnsResolver {
  txt = new Map<string, DnsResult<string[][]>>();
  mx = new Map<string, DnsResult<Array<{ exchange: string; priority: number }>>>();
  calls: Array<{ type: "TXT" | "MX"; name: string }> = [];

  setTxt(name: string, records: string[]): void {
    this.txt.set(name, { ok: true, value: records.map((record) => [record]) });
  }

  setTxtFailure(name: string, result: Extract<DnsResult<string[][]>, { ok: false }>): void {
    this.txt.set(name, result);
  }

  setMx(name: string, records: Array<{ exchange: string; priority: number }>): void {
    this.mx.set(name, { ok: true, value: records });
  }

  setMxFailure(
    name: string,
    result: Extract<DnsResult<Array<{ exchange: string; priority: number }>>, { ok: false }>,
  ): void {
    this.mx.set(name, result);
  }

  async resolveTxt(name: string): Promise<DnsResult<string[][]>> {
    this.calls.push({ type: "TXT", name });
    return this.txt.get(name) ?? { ok: true, value: [] };
  }

  async resolveMx(name: string): Promise<DnsResult<Array<{ exchange: string; priority: number }>>> {
    this.calls.push({ type: "MX", name });
    return this.mx.get(name) ?? { ok: true, value: [] };
  }
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    baseUrl: "http://127.0.0.1:4310",
    google: { clientId: null, clientSecret: null },
    microsoft: { clientId: null, clientSecret: null, tenant: "common" },
    sessionTtlMs: 60_000,
    planTtlMs: 60_000,
    limits: {
      maxScanMessages: 1000,
      pageSize: 50,
      executorBatchSize: 25,
      executorConcurrency: 3,
      previewSampleSize: 20,
      resultsSampleSize: 20,
    },
    ...overrides,
  };
}

export function makeProvider(
  messages: MessageMetadata[],
  options: ConstructorParameters<typeof SyntheticProvider>[1] = {},
): SyntheticProvider {
  return new SyntheticProvider(messages, { providerId: "microsoft", ...options });
}
