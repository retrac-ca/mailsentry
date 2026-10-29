import type { CleanupAction, JobMessageResult } from "../shared/types.js";
import { AppError, isAppError } from "./errors.js";
import { ACTION_INFO, actionAllowed } from "./capabilities.js";
import { evaluateEligibility } from "./eligibility.js";
import type { StoredPlan } from "./plan.js";
import { ProviderError } from "../providers/errors.js";
import type { MailProvider } from "../providers/provider.js";

export interface ExecutionProgress {
  processed: number;
  succeeded: number;
  failed: number;
  skippedChanged: number;
  uncertain: number;
  bytesRecovered: number;
}

export interface ExecutionResult {
  progress: ExecutionProgress;
  results: JobMessageResult[];
  resultsTruncated: boolean;
  cancelled: boolean;
  fatalError: string | null;
  warnings: string[];
}

export interface ExecutionOptions {
  provider: MailProvider;
  plan: StoredPlan;
  mode: "dry-run" | "execute";
  batchSize: number;
  concurrency: number;
  resultsSampleSize?: number;
  signal?: AbortSignal;
  now?: number;
  onProgress?: (progress: ExecutionProgress) => void;
  /** Required for irreversible actions in execute mode; checked here as well as at the HTTP gate. */
  confirmation?: string;
}

function isFatal(error: unknown): boolean {
  if (isAppError(error)) return error.code === "NOT_CONNECTED" || error.code === "FORBIDDEN";
  if (error instanceof ProviderError) {
    return error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN";
  }
  return false;
}

async function mutate(
  provider: MailProvider,
  action: CleanupAction,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  switch (action) {
    case "archive":
      await provider.archive(id, signal);
      return;
    case "trash":
      await provider.moveToTrash(id, signal);
      return;
    case "permanentDelete":
    case "emptyTrash":
      await provider.permanentlyDelete(id, signal);
      return;
  }
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof ProviderError) return error.code === "CANCELLED";
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

/**
 * Execute a reviewed cleanup plan with batched, bounded-concurrency work.
 *
 * - Re-reads each message and re-applies eligibility before any mutation.
 * - Dry-run performs the same reads but never calls a mutation method.
 * - Never retries a mutation itself; ambiguous provider failures are surfaced.
 * - Cancellation stops new work and reports in-flight operations accurately.
 */
export async function executeCleanup(options: ExecutionOptions): Promise<ExecutionResult> {
  const { provider, plan, mode, batchSize, concurrency, signal } = options;
  const now = options.now ?? Date.now();
  const resultsLimit = options.resultsSampleSize ?? 100;

  if (!actionAllowed(plan.provider, plan.action)) {
    throw new AppError("FORBIDDEN", "This provider does not support the planned action.", 403);
  }
  const actionInfo = ACTION_INFO[plan.action];
  if (
    mode === "execute" &&
    actionInfo.destructive &&
    actionInfo.confirmationPhrase &&
    options.confirmation !== actionInfo.confirmationPhrase
  ) {
    throw new AppError(
      "FORBIDDEN",
      `Permanent deletion requires the exact confirmation phrase: ${actionInfo.confirmationPhrase}`,
      403,
    );
  }

  const results: JobMessageResult[] = [];
  let resultsTruncated = false;
  let fatalError: string | null = null;

  const progress: ExecutionProgress = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    skippedChanged: 0,
    uncertain: 0,
    bytesRecovered: 0,
  };

  const pushResult = (
    id: string,
    subject: string | null,
    from: string | null,
    outcome: JobMessageResult["outcome"],
    detail: string,
  ) => {
    progress.processed += 1;
    if (outcome === "succeeded") progress.succeeded += 1;
    else if (outcome === "failed") progress.failed += 1;
    else if (outcome === "skipped-changed") progress.skippedChanged += 1;
    else progress.uncertain += 1;

    if (outcome === "succeeded") return;
    if (results.length < resultsLimit) {
      results.push({ id, subject, from, outcome, detail });
    } else {
      resultsTruncated = true;
    }
  };

  const handle = async (entry: { id: string; folder: string }): Promise<void> => {
    if (signal?.aborted) return;
    let current;
    try {
      current = await provider.getMessage(entry.id, signal);
    } catch (error) {
      if (isAbort(error, signal)) return;
      if (isFatal(error)) {
        fatalError = error instanceof Error ? error.message : "Authorization failure.";
      }
      pushResult(entry.id, null, null, "failed", "Could not revalidate this message; no change was made.");
      return;
    }
    if (!current) {
      pushResult(entry.id, null, null, "skipped-changed", "Message no longer exists; nothing was changed.");
      return;
    }
    if (current.folder !== entry.folder) {
      pushResult(
        entry.id,
        current.subject,
        current.from,
        "skipped-changed",
        "Message moved to a different folder after the preview; nothing was changed.",
      );
      return;
    }
    const eligibility = evaluateEligibility(current, plan.filters, now, {
      applyCriteria: plan.action !== "emptyTrash",
    });
    if (!eligibility.eligible) {
      pushResult(
        entry.id,
        current.subject,
        current.from,
        "skipped-changed",
        `No longer eligible: ${eligibility.reasons[0] ?? "criteria changed"}.`,
      );
      return;
    }
    if (mode === "dry-run") {
      pushResult(entry.id, current.subject, current.from, "succeeded", "Dry run: no change made.");
      return;
    }

    try {
      await mutate(provider, plan.action, entry.id, signal);
      if (plan.action === "permanentDelete" || plan.action === "emptyTrash") {
        progress.bytesRecovered += current.sizeBytes ?? 0;
      }
      pushResult(entry.id, current.subject, current.from, "succeeded", "Completed.");
    } catch (error) {
      if (isAbort(error, signal)) {
        pushResult(
          entry.id,
          current.subject,
          current.from,
          "uncertain",
          "Cancelled during the operation. The provider may have completed it; verify manually.",
        );
        return;
      }
      if (error instanceof ProviderError && error.notFound) {
        pushResult(
          entry.id,
          current.subject,
          current.from,
          "skipped-changed",
          "Provider reports the message is already gone.",
        );
        return;
      }
      if (isFatal(error)) {
        fatalError = error instanceof Error ? error.message : "Provider authorization failure.";
        pushResult(entry.id, current.subject, current.from, "failed", fatalError);
        return;
      }
      if (error instanceof ProviderError && error.ambiguous) {
        pushResult(
          entry.id,
          current.subject,
          current.from,
          "uncertain",
          `Provider did not confirm the outcome: ${error.message}`,
        );
        return;
      }
      pushResult(
        entry.id,
        current.subject,
        current.from,
        "failed",
        error instanceof Error ? error.message : "Provider operation failed.",
      );
    }
  };

  const entries = plan.entries;
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    if (signal?.aborted || fatalError) break;
    const batch = entries.slice(offset, offset + batchSize);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal?.aborted || fatalError) return;
        const index = cursor;
        cursor += 1;
        if (index >= batch.length) return;
        const entry = batch[index];
        if (entry) await handle(entry);
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(concurrency, batch.length)) }, () => worker()),
    );
    options.onProgress?.({ ...progress });
  }

  const warnings: string[] = [];
  if (mode === "dry-run") {
    warnings.push(
      "Dry run completed. No messages were changed; success counts are simulated and no storage was recovered.",
    );
  }
  if (progress.skippedChanged > 0) {
    warnings.push(
      `${progress.skippedChanged} message(s) changed or no longer matched the reviewed plan and were skipped. They were not modified.`,
    );
  }
  if (progress.uncertain > 0) {
    warnings.push(
      `${progress.uncertain} message(s) have an uncertain provider outcome. Check the mailbox before retrying; MailSentry will not retry them automatically.`,
    );
  }
  if (progress.failed > 0) {
    warnings.push(`${progress.failed} message operation(s) failed. Review the results below.`);
  }
  if (signal?.aborted) {
    warnings.push(
      "Execution was cancelled. Completed operations are reported; in-flight operations may have finished without confirmation. There is no rollback.",
    );
  }
  if (fatalError) {
    warnings.push("Execution stopped early because authorization or permissions failed.");
  }
  if (resultsTruncated) {
    warnings.push("Only the first set of problem results is shown; counts above are complete.");
  }
  if (
    (progress.succeeded > 0 && plan.action === "permanentDelete") ||
    (progress.succeeded > 0 && plan.action === "emptyTrash")
  ) {
    warnings.push("Permanently deleted messages cannot be recovered by MailSentry.");
  }

  options.onProgress?.({ ...progress });

  return {
    progress,
    results,
    resultsTruncated,
    cancelled: signal?.aborted === true,
    fatalError,
    warnings,
  };
}
