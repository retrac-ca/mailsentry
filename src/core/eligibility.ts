import type { CleanupAction, CleanupFilters, Eligibility, MessageMetadata } from "../shared/types.js";
import { AppError } from "./errors.js";

export interface FromParts {
  address: string | null;
  domain: string | null;
}

/** Extract an address and domain from common From header shapes without parsing MIME. */
export function parseFrom(from: string | null): FromParts {
  if (!from) return { address: null, domain: null };
  const bracketed = /<([^<>]+)>/.exec(from)?.[1];
  const candidate = (bracketed ?? from).trim().toLowerCase();
  const address = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
  const domain = address ? (address.split("@").at(-1) ?? null) : null;
  return { address, domain };
}

function matchesPattern(from: string | null, pattern: string): boolean {
  const { address, domain } = parseFrom(from);
  if (!address || !domain) return false;
  const needle = pattern.trim().toLowerCase();
  if (!needle) return false;
  if (needle.includes("@")) return address === needle;
  return domain === needle || domain.endsWith(`.${needle}`);
}

export function senderIsAllowlisted(from: string | null, filters: CleanupFilters): boolean {
  return filters.senderAllowlist.some((pattern) => matchesPattern(from, pattern));
}

function senderTargeted(from: string | null, filters: CleanupFilters): boolean {
  if (filters.senderTargets.length === 0) return true;
  return filters.senderTargets.some((pattern) => matchesPattern(from, pattern));
}

/**
 * Determines whether a message is eligible for the reviewed action.
 *
 * Safety properties:
 * - protection filters (starred/unread/important) default to excluding messages;
 * - uncertain metadata never becomes eligible;
 * - an empty criteria set never becomes eligible (except Empty Trash, where
 *   criteria are intentionally bypassed but protections still apply).
 */
export function evaluateEligibility(
  message: MessageMetadata,
  filters: CleanupFilters,
  nowMs: number,
  options: { applyCriteria?: boolean } = {},
): Eligibility {
  const applyCriteria = options.applyCriteria ?? true;
  const reasons: string[] = [];
  let uncertain = false;

  if (message.isDraft) {
    reasons.push("Draft messages are never eligible.");
  }
  if (senderIsAllowlisted(message.from, filters)) {
    reasons.push("Sender is on the never-clean allowlist.");
  }
  if (!senderTargeted(message.from, filters)) {
    reasons.push("Sender is not in the targeted sender list.");
  }
  if (message.isStarred && !filters.includeStarred) {
    reasons.push("Starred message (protected by default).");
  }
  if (message.isImportant && !filters.includeImportant) {
    reasons.push("Marked important (protected by default).");
  }
  if (!message.isRead && !filters.includeUnread) {
    reasons.push("Unread message (protected by default).");
  }

  if (applyCriteria) {
    if (filters.minAgeDays > 0) {
      const received = Date.parse(message.receivedAt);
      if (!Number.isFinite(received)) {
        uncertain = true;
        reasons.push("Message date could not be determined.");
      } else {
        const ageDays = (nowMs - received) / 86_400_000;
        if (ageDays < filters.minAgeDays) {
          reasons.push(`Younger than ${filters.minAgeDays} days.`);
        }
      }
    }

    if (filters.minSizeBytes !== null) {
      if (message.sizeBytes === null) {
        uncertain = true;
        reasons.push("Message size is unavailable from the provider.");
      } else if (message.sizeBytes < filters.minSizeBytes) {
        reasons.push("Smaller than the minimum size filter.");
      }
    }

    if (filters.largeAttachmentBytes !== null) {
      if (!message.hasAttachments) {
        reasons.push("Has no attachments.");
      } else if (message.attachmentBytes === null) {
        uncertain = true;
        reasons.push(
          "Attachment size is unavailable from the provider, so this message cannot be safely matched.",
        );
      } else if (message.attachmentBytes < filters.largeAttachmentBytes) {
        reasons.push("Attachments are below the size filter.");
      }
    }

    if (filters.bulkOnly) {
      if (message.bulk.level === "none") {
        reasons.push("Not classified as bulk or newsletter mail.");
      } else if (message.bulk.level === "possible") {
        uncertain = true;
        reasons.push("Bulk-mail classification is uncertain.");
      }
    }
  }

  return {
    eligible: reasons.length === 0,
    uncertain,
    reasons,
    sizeBytes: message.sizeBytes,
  };
}

/** Require at least one positive selection criterion for normal cleanup actions. */
export function assertFiltersUsable(action: CleanupAction, filters: CleanupFilters): void {
  if (action === "emptyTrash") return;
  const hasCriterion =
    filters.minAgeDays > 0 ||
    filters.minSizeBytes !== null ||
    filters.largeAttachmentBytes !== null ||
    filters.bulkOnly ||
    filters.senderTargets.length > 0;
  if (!hasCriterion) {
    throw new AppError(
      "VALIDATION",
      "Enable at least one filter (age, size, attachments, bulk mail, or targeted senders) before scanning. This prevents an unintended whole-folder cleanup.",
      400,
    );
  }
}
