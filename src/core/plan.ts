import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ActionInfo,
  CleanupAction,
  CleanupFilters,
  CleanupPreview,
  ExecuteRequest,
  FolderCount,
  FolderKind,
  PreviewMessage,
  ProviderId,
} from "../shared/types.js";
import { ACTION_INFO, actionAllowed } from "./capabilities.js";
import { AppError } from "./errors.js";

export interface PlanEntry {
  id: string;
  folder: FolderKind;
}

export interface CreatePlanInput {
  sessionId: string;
  connectionToken: string;
  provider: ProviderId;
  folders: FolderKind[];
  filters: CleanupFilters;
  action: CleanupAction;
  entries: PlanEntry[];
  scannedCount: number;
  eligibleBytes: number;
  uncertainCount: number;
  byFolder: FolderCount[];
  sample: PreviewMessage[];
  sampleTruncated: boolean;
  warnings: string[];
  limitations: string[];
  ttlMs: number;
}

export interface StoredPlan {
  planId: string;
  planHash: string;
  reviewToken: string;
  ownerSessionId: string;
  connectionToken: string;
  provider: ProviderId;
  folders: FolderKind[];
  filters: CleanupFilters;
  action: CleanupAction;
  entries: PlanEntry[];
  preview: CleanupPreview;
  expiresAt: number;
}

function canonicalFilters(filters: CleanupFilters): CleanupFilters {
  return {
    minAgeDays: filters.minAgeDays,
    minSizeBytes: filters.minSizeBytes,
    largeAttachmentBytes: filters.largeAttachmentBytes,
    bulkOnly: filters.bulkOnly,
    senderAllowlist: [...filters.senderAllowlist].sort(),
    senderTargets: [...filters.senderTargets].sort(),
    includeStarred: filters.includeStarred,
    includeUnread: filters.includeUnread,
    includeImportant: filters.includeImportant,
  };
}

export function computePlanHash(input: {
  provider: ProviderId;
  folders: FolderKind[];
  filters: CleanupFilters;
  action: CleanupAction;
  entries: PlanEntry[];
}): string {
  const entries = [...input.entries]
    .sort((a, b) => (a.id === b.id ? a.folder.localeCompare(b.folder) : a.id.localeCompare(b.id)))
    .map((entry) => [entry.id, entry.folder]);
  const canonical = JSON.stringify({
    version: 1,
    provider: input.provider,
    folders: input.folders,
    filters: canonicalFilters(input.filters),
    action: input.action,
    entries,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** In-memory, TTL-bounded plan store. Plans are never written to disk. */
export class PlanStore {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly ttlMs: number;
  private readonly maxPlans: number;

  constructor(ttlMs: number, maxPlans = 10) {
    this.ttlMs = ttlMs;
    this.maxPlans = maxPlans;
  }

  private prune(now: number): void {
    for (const [id, plan] of this.plans) {
      if (plan.expiresAt <= now) this.plans.delete(id);
    }
    while (this.plans.size >= this.maxPlans) {
      const oldest = [...this.plans.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
      if (!oldest) break;
      this.plans.delete(oldest.planId);
    }
  }

  create(input: CreatePlanInput, now = Date.now()): CleanupPreview {
    this.prune(now);
    const planId = randomBytes(16).toString("base64url");
    const reviewToken = randomBytes(32).toString("base64url");
    const planHash = computePlanHash(input);
    const expiresAt = now + this.ttlMs;
    const actionInfo = ACTION_INFO[input.action] as ActionInfo;

    const preview: CleanupPreview = {
      planId,
      planHash,
      reviewToken,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      provider: input.provider,
      folders: [...input.folders],
      filters: canonicalFilters(input.filters),
      action: input.action,
      actionInfo,
      scannedCount: input.scannedCount,
      eligibleCount: input.entries.length,
      eligibleBytes: input.eligibleBytes,
      uncertainCount: input.uncertainCount,
      byFolder: input.byFolder,
      sample: input.sample.slice(0, 100),
      sampleTruncated: input.sampleTruncated,
      warnings: input.warnings,
      limitations: input.limitations,
    };

    this.plans.set(planId, {
      planId,
      planHash,
      reviewToken,
      ownerSessionId: input.sessionId,
      connectionToken: input.connectionToken,
      provider: input.provider,
      folders: [...input.folders],
      filters: canonicalFilters(input.filters),
      action: input.action,
      entries: input.entries.map((entry) => ({ ...entry })),
      preview,
      expiresAt,
    });
    return preview;
  }

  get(planId: string, now = Date.now()): StoredPlan | undefined {
    const plan = this.plans.get(planId);
    if (!plan) return undefined;
    if (plan.expiresAt <= now) {
      this.plans.delete(planId);
      return undefined;
    }
    return plan;
  }

  /** Remove a plan at execution start so a reviewed plan cannot be replayed. */
  take(planId: string): StoredPlan | undefined {
    const plan = this.plans.get(planId);
    if (plan) this.plans.delete(planId);
    return plan;
  }

  size(): number {
    return this.plans.size;
  }
}

/**
 * Server-side execution gate. A preview's hash, one-time review token, expiry,
 * provider capability, and (for irreversible actions) exact confirmation phrase
 * must all match. This is independent of any UI confirmation.
 */
export function assertExecutionAllowed(plan: StoredPlan, request: ExecuteRequest, now = Date.now()): void {
  if (plan.expiresAt <= now) {
    throw new AppError("CONFLICT", "This preview has expired. Scan again before executing.", 409);
  }
  if (request.planHash !== plan.planHash) {
    throw new AppError(
      "CONFLICT",
      "The cleanup plan changed after review. Review the updated preview before executing.",
      409,
    );
  }
  if (!safeEqual(request.reviewToken, plan.reviewToken)) {
    throw new AppError("FORBIDDEN", "The review token is missing or invalid. Review the preview again.", 403);
  }
  if (!actionAllowed(plan.provider, plan.action)) {
    throw new AppError(
      "FORBIDDEN",
      `${plan.provider === "gmail" ? "Gmail" : "Microsoft"} does not support this action with MailSentry's permissions.`,
      403,
    );
  }
  const info = ACTION_INFO[plan.action];
  if (request.mode === "execute" && info.destructive) {
    if (!info.confirmationPhrase || request.confirmation !== info.confirmationPhrase) {
      throw new AppError(
        "FORBIDDEN",
        `Permanent deletion requires typing the exact confirmation phrase: ${info.confirmationPhrase ?? "DELETE PERMANENTLY"}`,
        403,
      );
    }
  }
  if (request.mode !== "dry-run" && request.mode !== "execute") {
    throw new AppError("VALIDATION", "Unknown execution mode.", 400);
  }
}

export function actionRequiresTrashFolder(action: CleanupAction): boolean {
  return action === "emptyTrash";
}
