import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RateLimiter } from "../core/batch.js";
import { capabilitiesFor } from "../core/capabilities.js";
import { executeCleanup } from "../core/executor.js";
import { PlanStore } from "../core/plan.js";
import { scanMailbox } from "../core/scan.js";
import type {
  CleanupFilters,
  FolderKind,
  MessageMetadata,
  ProviderCapabilities,
  ProviderId,
} from "../shared/types.js";
import { SyntheticProvider, syntheticMessage } from "../providers/synthetic.js";
import type { MailProvider, ProviderPage } from "../providers/provider.js";

interface Scenario {
  name: string;
  messages: number;
  execute: boolean;
  cancelAfterMs?: number;
  ratePerSecond?: number;
  latencyMs?: number;
  description: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "scan-2k",
    messages: 2_000,
    execute: false,
    description: "2,000-message paginated scan + preview plan",
  },
  {
    name: "scan-30k",
    messages: 30_000,
    execute: false,
    description: "30,000-message paginated scan + preview plan",
  },
  {
    name: "dryrun-20k",
    messages: 20_000,
    execute: true,
    description: "20,000-message scan + dry-run execution (revalidation reads, no mutations)",
  },
  {
    name: "cancel-5k",
    messages: 5_000,
    execute: true,
    cancelAfterMs: 100,
    latencyMs: 1,
    description: "5,000-message dry run cancelled after 100 ms with 1 ms simulated provider latency",
  },
  {
    name: "rate-300",
    messages: 300,
    execute: true,
    ratePerSecond: 100,
    description: "300-message dry run through a 100 request/second limiter",
  },
];

const FILTERS: CleanupFilters = {
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

interface ScenarioResult {
  scenario: string;
  description: string;
  messages: number;
  eligible: number;
  processed: number;
  elapsedMs: number;
  peakRssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  batchSize: number;
  concurrency: number;
  pageSize: number;
  apiCalls: Record<string, number>;
  rateLimitPerSecond: number | null;
  cancelled: boolean;
  succeeded: number;
  failed: number;
  uncertain: number;
  skippedChanged: number;
  nodeVersion: string;
  platform: string;
}

function peakRssBytes(): number {
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const match = /VmHWM:\s+(\d+)\s+kB/.exec(status);
    if (match?.[1]) return Number(match[1]) * 1024;
  } catch {
    // Non-Linux fallback below.
  }
  return process.memoryUsage().rss;
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function makeMailbox(count: number): MessageMetadata[] {
  const random = rng(42);
  const messages: MessageMetadata[] = [];
  const now = Date.now();
  for (let index = 0; index < count; index += 1) {
    const roll = random();
    const folder: FolderKind = roll < 0.7 ? "inbox" : roll < 0.85 ? "spam" : "trash";
    const ageDays = 400 + Math.floor(random() * 900);
    const senderIndex = index % 400;
    messages.push(
      syntheticMessage(`m${index}`, {
        folder,
        receivedAt: new Date(now - ageDays * 86_400_000).toISOString(),
        subject: `Synthetic message ${index} about account activity and routine notices`,
        from:
          senderIndex % 9 === 0
            ? `newsletter${senderIndex}@example.test`
            : `person${senderIndex}@example.test`,
        sizeBytes: 15_000 + Math.floor(random() * 4_000_000),
        isRead: true,
        isStarred: random() < 0.02,
        isImportant: random() < 0.01,
        bulk:
          senderIndex % 9 === 0
            ? { level: "likely", evidence: "List-Unsubscribe/List-Id headers present." }
            : { level: "none", evidence: null },
      }),
    );
  }
  return messages;
}

class PacedProvider implements MailProvider {
  readonly id: ProviderId;
  readonly account: string | null;
  readonly capabilities: ProviderCapabilities;
  readonly mode = "cleanup" as const;

  constructor(
    private readonly delegate: SyntheticProvider,
    private readonly limiter: RateLimiter,
  ) {
    this.id = delegate.id;
    this.account = delegate.account;
    this.capabilities = delegate.capabilities ?? capabilitiesFor(delegate.id);
  }

  async listMessages(
    folder: FolderKind,
    pageToken: string | null,
    signal?: AbortSignal,
  ): Promise<ProviderPage> {
    await this.limiter.acquire(signal);
    return this.delegate.listMessages(folder, pageToken, signal);
  }

  async getMessage(id: string, signal?: AbortSignal): Promise<MessageMetadata | null> {
    await this.limiter.acquire(signal);
    return this.delegate.getMessage(id, signal);
  }

  async archive(id: string, signal?: AbortSignal): Promise<void> {
    await this.limiter.acquire(signal);
    return this.delegate.archive(id, signal);
  }

  async moveToTrash(id: string, signal?: AbortSignal): Promise<void> {
    await this.limiter.acquire(signal);
    return this.delegate.moveToTrash(id, signal);
  }

  async permanentlyDelete(id: string, signal?: AbortSignal): Promise<void> {
    await this.limiter.acquire(signal);
    return this.delegate.permanentlyDelete(id, signal);
  }
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const started = performance.now();
  const batchSize = 25;
  const concurrency = 3;
  const pageSize = 50;
  const mailbox = makeMailbox(scenario.messages);
  const synthetic = new SyntheticProvider(mailbox, {
    pageSize,
    mode: "cleanup",
    latencyMs: scenario.latencyMs ?? 0,
  });
  const provider: MailProvider =
    scenario.ratePerSecond !== undefined
      ? new PacedProvider(synthetic, new RateLimiter(scenario.ratePerSecond, scenario.ratePerSecond))
      : synthetic;

  const scan = await scanMailbox({
    provider,
    providerId: "gmail",
    folders: ["inbox", "spam"],
    filters: FILTERS,
    action: "trash",
    maxMessages: 100_000,
    pageSize,
    sampleSize: 100,
  });

  const store = new PlanStore(20 * 60 * 1000);
  const preview = store.create({
    sessionId: "benchmark-session",
    connectionToken: "benchmark-connection",
    provider: "gmail",
    folders: ["inbox", "spam"],
    filters: FILTERS,
    action: "trash",
    entries: scan.entries,
    scannedCount: scan.scannedCount,
    eligibleBytes: scan.eligibleBytes,
    uncertainCount: scan.uncertainCount,
    byFolder: scan.byFolder,
    sample: scan.sample,
    sampleTruncated: scan.sampleTruncated,
    warnings: scan.warnings,
    limitations: scan.limitations,
    ttlMs: 20 * 60 * 1000,
  });

  let processed = 0;
  let cancelled = false;
  const counters = { succeeded: 0, failed: 0, uncertain: 0, skippedChanged: 0 };

  if (scenario.execute) {
    const plan = store.get(preview.planId);
    if (!plan) throw new Error("Plan missing");
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    if (scenario.cancelAfterMs !== undefined) {
      timer = setTimeout(() => controller.abort(), scenario.cancelAfterMs);
      timer.unref();
    }
    const result = await executeCleanup({
      provider,
      plan,
      mode: "dry-run",
      batchSize,
      concurrency,
      resultsSampleSize: 100,
      signal: controller.signal,
    });
    if (timer) clearTimeout(timer);
    processed = result.progress.processed;
    cancelled = result.cancelled;
    counters.succeeded = result.progress.succeeded;
    counters.failed = result.progress.failed;
    counters.uncertain = result.progress.uncertain;
    counters.skippedChanged = result.progress.skippedChanged;
  }

  const elapsedMs = performance.now() - started;
  const usage = process.memoryUsage();
  return {
    scenario: scenario.name,
    description: scenario.description,
    messages: scenario.messages,
    eligible: scan.entries.length,
    processed,
    elapsedMs: Math.round(elapsedMs),
    peakRssBytes: peakRssBytes(),
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    batchSize,
    concurrency,
    pageSize,
    apiCalls: { ...synthetic.getCallCounts() },
    rateLimitPerSecond: scenario.ratePerSecond ?? null,
    cancelled,
    succeeded: counters.succeeded,
    failed: counters.failed,
    uncertain: counters.uncertain,
    skippedChanged: counters.skippedChanged,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
  };
}

async function main(): Promise<void> {
  const childArg = process.argv.find((arg) => arg.startsWith("--scenario="));
  if (childArg) {
    const name = childArg.slice("--scenario=".length);
    const scenario = SCENARIOS.find((entry) => entry.name === name);
    if (!scenario) {
      process.stderr.write(`Unknown scenario: ${name}\n`);
      process.exit(2);
    }
    const result = await runScenario(scenario);
    process.stdout.write(`BENCH_RESULT ${JSON.stringify(result)}\n`);
    return;
  }

  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    const child = spawnSync(
      process.execPath,
      [process.argv[1] ?? "dist/bench/memory.js", `--scenario=${scenario.name}`],
      {
        encoding: "utf8",
        timeout: 10 * 60 * 1000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (child.status !== 0) {
      process.stderr.write(child.stderr || `Scenario ${scenario.name} failed\n`);
      process.exit(1);
    }
    const line = child.stdout.split("\n").find((entry) => entry.startsWith("BENCH_RESULT "));
    if (!line) {
      process.stderr.write(`Scenario ${scenario.name} produced no result\n`);
      process.exit(1);
    }
    results.push(JSON.parse(line.slice("BENCH_RESULT ".length)) as ScenarioResult);
  }

  const environment = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu:
      (await readFile("/proc/cpuinfo", "utf8").catch(() => "")).match(/model name\s*:\s*(.+)/)?.[1]?.trim() ??
      "unknown",
    methodology:
      "Each scenario runs in its own Node.js process. Peak RSS is /proc/self/status VmHWM (fallback: current RSS). Synthetic mailbox is generated with a fixed seed; no network calls occur.",
  };

  process.stdout.write(`\nMailSentry memory benchmark\n${"=".repeat(26)}\n`);
  process.stdout.write(`Node ${environment.node} · ${environment.platform} · ${environment.cpu}\n\n`);
  for (const result of results) {
    process.stdout.write(`Scenario: ${result.scenario} (${result.description})\n`);
    process.stdout.write(
      `  messages=${result.messages} eligible=${result.eligible} processed=${result.processed}\n`,
    );
    process.stdout.write(
      `  elapsed=${result.elapsedMs} ms  peakRSS=${(result.peakRssBytes / 1024 / 1024).toFixed(1)} MiB  heapUsed=${(result.heapUsedBytes / 1024 / 1024).toFixed(1)} MiB\n`,
    );
    process.stdout.write(
      `  batch=${result.batchSize} concurrency=${result.concurrency} pageSize=${result.pageSize}\n`,
    );
    process.stdout.write(
      `  apiCalls=${JSON.stringify(result.apiCalls)} rateLimit=${result.rateLimitPerSecond ?? "none"}/s cancelled=${result.cancelled}\n\n`,
    );
  }

  const dir = resolve(process.cwd(), "bench", "results");
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, "latest.json");
  await writeFile(file, `${JSON.stringify({ environment, results }, null, 2)}\n`, "utf8");
  process.stdout.write(`Results written to ${file}\n`);
}

await main();
