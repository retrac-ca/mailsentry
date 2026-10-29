import { describe, expect, it } from "vitest";
import { PlanStore, assertExecutionAllowed } from "../../src/core/plan.js";
import { scanMailbox } from "../../src/core/scan.js";
import { executeCleanup } from "../../src/core/executor.js";
import type { CleanupAction, CleanupFilters, FolderKind, ProviderId } from "../../src/shared/types.js";
import type { SyntheticProvider } from "../../src/providers/synthetic.js";
import { ProviderError } from "../../src/providers/errors.js";
import { AppError } from "../../src/core/errors.js";
import { BASE_FILTERS, NOW, makeMessages, makeProvider } from "../helpers/fixtures.js";
async function scanAndPlan(
  provider: SyntheticProvider,
  options: {
    folders?: FolderKind[];
    action?: CleanupAction;
    filters?: CleanupFilters;
    providerId?: ProviderId;
    maxMessages?: number;
    sampleSize?: number;
  } = {},
) {
  const folders = options.folders ?? ["inbox"];
  const action = options.action ?? "trash";
  const filters = options.filters ?? BASE_FILTERS;
  const scan = await scanMailbox({
    provider,
    providerId: options.providerId ?? provider.id,
    folders,
    filters,
    action,
    maxMessages: options.maxMessages ?? 10_000,
    pageSize: 50,
    sampleSize: options.sampleSize ?? 100,
    now: NOW,
  });
  const store = new PlanStore(60_000, 10);
  const preview = store.create(
    {
      sessionId: "test-session",
      connectionToken: "test-connection",
      provider: options.providerId ?? provider.id,
      folders,
      filters,
      action,
      entries: scan.entries,
      scannedCount: scan.scannedCount,
      eligibleBytes: scan.eligibleBytes,
      uncertainCount: scan.uncertainCount,
      byFolder: scan.byFolder,
      sample: scan.sample,
      sampleTruncated: scan.sampleTruncated,
      warnings: scan.warnings,
      limitations: scan.limitations,
      ttlMs: 60_000,
    },
    NOW,
  );
  const plan = store.get(preview.planId, NOW);
  if (!plan) throw new Error("plan missing");
  return { scan, preview, plan, store };
}

function execute(
  provider: SyntheticProvider,
  plan: Parameters<typeof executeCleanup>[0]["plan"],
  overrides: Partial<Parameters<typeof executeCleanup>[0]> = {},
) {
  return executeCleanup({
    provider,
    plan,
    mode: "dry-run",
    batchSize: 25,
    concurrency: 3,
    now: NOW,
    ...overrides,
  });
}

describe("read-only scanning and preview", () => {
  it("scans paginated messages without any mutation call", async () => {
    const provider = makeProvider(makeMessages(123));
    const { scan, preview } = await scanAndPlan(provider);
    expect(scan.scannedCount).toBe(123);
    expect(scan.entries).toHaveLength(123);
    expect(preview.sample.length).toBeLessThanOrEqual(100);
    expect(provider.getMutations()).toEqual([]);
    const counts = provider.getCallCounts();
    expect(counts.archive).toBe(0);
    expect(counts.trash).toBe(0);
    expect(counts.permanentDelete).toBe(0);
    expect(counts.list).toBe(3);
  });

  it("retains only ids/folders plus a bounded sample", async () => {
    const provider = makeProvider(makeMessages(300));
    const { scan, preview } = await scanAndPlan(provider, { sampleSize: 20 });
    expect(scan.entries[0]).toEqual({ id: "inbox-0", folder: "inbox" });
    expect(Object.keys(scan.entries[0] ?? {})).toEqual(["id", "folder"]);
    expect(preview.sample).toHaveLength(20);
    expect(preview.sampleTruncated).toBe(true);
    expect(scan.eligibleBytes).toBeGreaterThan(0);
  });

  it("truncates scans at the configured bound", async () => {
    const provider = makeProvider(makeMessages(100));
    const { scan } = await scanAndPlan(provider, { maxMessages: 40 });
    expect(scan.scannedCount).toBe(40);
    expect(scan.warnings[0]).toMatch(/stopped after 40/);
  });

  it("handles empty mailboxes", async () => {
    const provider = makeProvider([]);
    const { scan, preview } = await scanAndPlan(provider);
    expect(scan.scannedCount).toBe(0);
    expect(preview.eligibleCount).toBe(0);
    expect(preview.warnings.join(" ")).toMatch(/No messages matched/);
  });
});

describe("dry runs", () => {
  it("performs revalidation reads but never mutates", async () => {
    const provider = makeProvider(makeMessages(5));
    const { plan } = await scanAndPlan(provider);
    const before = [...provider.getMessageIds()];
    const result = await execute(provider, plan);
    expect(result.progress.processed).toBe(5);
    expect(result.progress.succeeded).toBe(5);
    expect(result.cancelled).toBe(false);
    expect(provider.getMutations()).toEqual([]);
    expect(provider.getCallCounts().archive).toBe(0);
    expect(provider.getCallCounts().trash).toBe(0);
    expect(provider.getMessageIds()).toEqual(before);
    expect(result.warnings.join(" ")).toMatch(/No messages were changed/);
  });
});

describe("folder independence", () => {
  it("does not include or modify spam/trash during an inbox scan", async () => {
    const provider = makeProvider([
      ...makeMessages(3, "inbox"),
      ...makeMessages(3, "spam"),
      ...makeMessages(3, "trash"),
    ]);
    const { plan } = await scanAndPlan(provider, { folders: ["inbox"], action: "trash" });
    expect(plan.entries.every((entry) => entry.folder === "inbox")).toBe(true);
    await execute(provider, plan, { mode: "execute" });
    const mutated = provider.getMutations().map((call) => call.id);
    expect(mutated.sort()).toEqual(["inbox-0", "inbox-1", "inbox-2"]);
    expect(provider.getMessageIds().filter((id) => id.startsWith("spam-"))).toHaveLength(3);
    expect(provider.getMessageIds().filter((id) => id.startsWith("trash-"))).toHaveLength(3);
  });

  it("does not include the inbox when only spam is selected", async () => {
    const provider = makeProvider([...makeMessages(2, "inbox"), ...makeMessages(2, "spam")]);
    const { plan } = await scanAndPlan(provider, { folders: ["spam"], action: "trash" });
    expect(plan.entries.every((entry) => entry.folder === "spam")).toBe(true);
    await execute(provider, plan, { mode: "execute" });
    expect(
      provider
        .getMutations()
        .map((call) => call.id)
        .sort(),
    ).toEqual(["spam-0", "spam-1"]);
    expect(provider.getMessageIds().filter((id) => id.startsWith("inbox-"))).toHaveLength(2);
  });

  it("rejects archive outside the inbox and trash-to-trash", async () => {
    const provider = makeProvider(makeMessages(2, "spam"));
    await expect(scanAndPlan(provider, { folders: ["spam"], action: "archive" })).rejects.toThrow(AppError);
    await expect(scanAndPlan(provider, { folders: ["trash"], action: "trash" })).rejects.toThrow(AppError);
  });
});

describe("permanent deletion and empty trash", () => {
  it("requires the confirmation phrase at the execution gate and then deletes", async () => {
    const provider = makeProvider(makeMessages(3));
    const { plan } = await scanAndPlan(provider, { action: "permanentDelete" });
    expect(() =>
      assertExecutionAllowed(
        plan,
        { planId: plan.planId, planHash: plan.planHash, reviewToken: plan.reviewToken, mode: "execute" },
        NOW,
      ),
    ).toThrow(/confirmation/i);
    await expect(execute(provider, plan, { mode: "execute" })).rejects.toThrow(/confirmation/i);
    const result = await execute(provider, plan, {
      mode: "execute",
      confirmation: "DELETE PERMANENTLY",
    });
    expect(result.progress.succeeded).toBe(3);
    expect(provider.getMessageIds()).toEqual([]);
    expect(provider.getMutations().every((call) => call.action === "permanentDelete")).toBe(true);
  });

  it("empties only eligible trash messages and honours protections", async () => {
    const starred = { ...makeMessages(1, "trash")[0]!, id: "trash-starred", isStarred: true };
    const provider = makeProvider([...makeMessages(3, "trash"), ...makeMessages(1, "inbox"), starred]);
    const { plan } = await scanAndPlan(provider, {
      folders: ["trash"],
      action: "emptyTrash",
      filters: { ...BASE_FILTERS, minAgeDays: 0 },
    });
    expect(plan.entries).toHaveLength(3);
    await execute(provider, plan, { mode: "execute", confirmation: "DELETE PERMANENTLY" });
    expect(provider.getMessageIds().sort()).toEqual(["inbox-0", "trash-starred"]);
  });

  it("is disabled for Gmail", async () => {
    const provider = makeProvider(makeMessages(1, "trash"), { providerId: "gmail" });
    await expect(
      scanAndPlan(provider, { folders: ["trash"], action: "emptyTrash", providerId: "gmail" }),
    ).rejects.toThrow(/does not support|full-mailbox/i);
  });
});

describe("changes between preview and execution", () => {
  it("skips messages that moved, disappeared, or no longer match", async () => {
    const provider = makeProvider(makeMessages(6));
    const { plan } = await scanAndPlan(provider);
    provider.setMessage("inbox-0", { folder: "other" });
    provider.removeMessage("inbox-1");
    provider.setMessage("inbox-2", { isStarred: true });
    const result = await execute(provider, plan, { mode: "execute" });
    expect(result.progress.processed).toBe(6);
    expect(result.progress.succeeded).toBe(3);
    expect(result.progress.skippedChanged).toBe(3);
    expect(
      provider
        .getMutations()
        .map((call) => call.id)
        .sort(),
    ).toEqual(["inbox-3", "inbox-4", "inbox-5"]);
    expect(result.warnings.join(" ")).toMatch(/changed or no longer matched/);
  });

  it("does not act on new messages that were not in the reviewed plan", async () => {
    const provider = makeProvider(makeMessages(2));
    const { plan } = await scanAndPlan(provider);
    provider.addMessage({ ...makeMessages(1, "inbox")[0]!, id: "inbox-new" });
    await execute(provider, plan, { mode: "execute" });
    expect(provider.getMessageIds()).toContain("inbox-new");
  });
});

describe("failure and uncertainty reporting", () => {
  it("reports confirmed failures without counting them as successes", async () => {
    const provider = makeProvider(makeMessages(3), {
      failures: [
        {
          operation: "trash",
          id: "inbox-1",
          times: 1,
          error: new ProviderError("Provider refused this message.", { code: "HTTP_ERROR", status: 400 }),
        },
      ],
    });
    const { plan } = await scanAndPlan(provider);
    const result = await execute(provider, plan, { mode: "execute" });
    expect(result.progress.succeeded).toBe(2);
    expect(result.progress.failed).toBe(1);
    expect(result.results.find((entry) => entry.id === "inbox-1")?.outcome).toBe("failed");
    expect(result.progress.uncertain).toBe(0);
    expect(provider.getMessageIds()).toContain("inbox-1");
  });

  it("reports ambiguous outcomes as uncertain and does not retry", async () => {
    const provider = makeProvider(makeMessages(2), {
      failures: [
        {
          operation: "trash",
          id: "inbox-0",
          times: 1,
          error: new ProviderError("Network failure after request.", {
            code: "TIMEOUT",
            ambiguous: true,
          }),
        },
      ],
    });
    const { plan } = await scanAndPlan(provider);
    const result = await execute(provider, plan, { mode: "execute" });
    expect(result.progress.uncertain).toBe(1);
    expect(result.progress.succeeded).toBe(1);
    expect(result.progress.failed).toBe(0);
    expect(result.results.find((entry) => entry.id === "inbox-0")?.outcome).toBe("uncertain");
    expect(result.warnings.join(" ")).toMatch(/uncertain/);
  });

  it("stops on authorization failure and does not report success", async () => {
    const provider = makeProvider(makeMessages(4), {
      failures: [
        {
          operation: "trash",
          times: 10,
          error: new ProviderError("Authorization expired.", { code: "UNAUTHORIZED", status: 401 }),
        },
      ],
    });
    const { plan } = await scanAndPlan(provider);
    const result = await execute(provider, plan, { mode: "execute" });
    expect(result.fatalError).toBeTruthy();
    expect(result.progress.succeeded).toBe(0);
    expect(result.progress.processed).toBeLessThanOrEqual(3);
    expect(provider.getMessageIds()).toHaveLength(4);
  });

  it("refuses mutations from a read-only provider as defence in depth", async () => {
    const provider = makeProvider(makeMessages(2), { mode: "readonly" });
    const { plan } = await scanAndPlan(provider);
    const result = await execute(provider, plan, { mode: "execute" });
    expect(result.progress.succeeded).toBe(0);
    expect(result.fatalError).toMatch(/read-only/i);
    expect(provider.getMessageIds()).toHaveLength(2);
  });
});

describe("cancellation", () => {
  it("stops work, reports partial completion, and never claims rollback", async () => {
    const provider = makeProvider(makeMessages(40), { mutationDelayMs: 4 });
    const { plan } = await scanAndPlan(provider, { action: "archive" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await execute(provider, plan, { mode: "execute", signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.progress.processed).toBeLessThan(40);
    expect(result.warnings.join(" ")).toMatch(/cancelled/i);
    expect(result.warnings.join(" ")).toMatch(/no rollback|may have finished/i);
  });
});

describe("filter semantics at scan time", () => {
  it("rejects the attachment-size filter when the provider has no attachment metadata", async () => {
    const provider = makeProvider(makeMessages(1));
    await expect(
      scanAndPlan(provider, { filters: { ...BASE_FILTERS, largeAttachmentBytes: 1_000_000 } }),
    ).rejects.toThrow(/attachment sizes/i);
  });

  it("requires at least one positive criterion for normal cleanup", async () => {
    const provider = makeProvider(makeMessages(1));
    await expect(
      scanAndPlan(provider, {
        filters: { ...BASE_FILTERS, minAgeDays: 0, minSizeBytes: null, bulkOnly: false },
      }),
    ).rejects.toThrow(/at least one filter/i);
  });

  it("reports uncertain bulk classifications separately", async () => {
    const base = makeMessages(2, "inbox");
    const provider = makeProvider([
      { ...base[0]!, bulk: { level: "possible", evidence: "heuristic" } },
      { ...base[1]!, bulk: { level: "likely", evidence: "List-Id" } },
    ]);
    const { scan, preview } = await scanAndPlan(provider, {
      filters: { ...BASE_FILTERS, bulkOnly: true },
    });
    expect(scan.entries.map((entry) => entry.id)).toEqual(["inbox-1"]);
    expect(preview.uncertainCount).toBe(1);
  });
});
