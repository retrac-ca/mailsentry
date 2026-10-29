import type {
  CleanupAction,
  CleanupFilters,
  FolderCount,
  FolderKind,
  PreviewMessage,
  ProviderCapabilities,
  ProviderId,
} from "../shared/types.js";
import { AppError } from "./errors.js";
import { assertFiltersUsable, evaluateEligibility } from "./eligibility.js";
import type { MailProvider } from "../providers/provider.js";
import { ACTION_INFO } from "./capabilities.js";
import { FOLDER_ORDER } from "../providers/provider.js";

export interface ScanOptions {
  provider: MailProvider;
  providerId: ProviderId;
  folders: FolderKind[];
  filters: CleanupFilters;
  action: CleanupAction;
  maxMessages: number;
  pageSize: number;
  sampleSize: number;
  signal?: AbortSignal;
  now?: number;
}

export interface ScanOutput {
  scannedCount: number;
  eligibleBytes: number;
  uncertainCount: number;
  entries: Array<{ id: string; folder: FolderKind }>;
  byFolder: FolderCount[];
  sample: PreviewMessage[];
  sampleTruncated: boolean;
  warnings: string[];
  limitations: string[];
}

/** Some action/folder combinations have no meaningful or safe provider semantics. */
export function assertActionFolders(action: CleanupAction, folders: FolderKind[]): void {
  if (action === "archive") {
    if (folders.length !== 1 || folders[0] !== "inbox") {
      throw new AppError(
        "VALIDATION",
        "Archive removes the Inbox label, so it can only target the Inbox. Deselect other folders or choose a different action.",
        400,
      );
    }
  }
  if (action === "trash" && folders.includes("trash")) {
    throw new AppError(
      "VALIDATION",
      "Messages already in Trash cannot be moved to Trash. Choose a different folder or action.",
      400,
    );
  }
  if (action === "emptyTrash" && (folders.length !== 1 || folders[0] !== "trash")) {
    throw new AppError("VALIDATION", "Empty Trash can only target the Trash folder by itself.", 400);
  }
}

function folderDisplayName(capabilities: ProviderCapabilities, folder: FolderKind): string {
  return capabilities.folders[folder].displayName;
}

function limitationsFor(
  providerId: ProviderId,
  capabilities: ProviderCapabilities,
  action: CleanupAction,
): string[] {
  const limitations = [
    "Scanning and preview are metadata-only and read-only. No message bodies or attachments are downloaded.",
    "Message sizes are provider estimates and may differ from storage accounting.",
    "Preview results reflect the mailbox at scan time; messages can change before execution.",
    "MailSentry cannot verify sender authenticity or message content during cleanup.",
  ];
  if (!capabilities.metadata.attachmentSize) {
    limitations.push(
      "This provider does not expose attachment sizes in message listings, so attachment-size filtering is unavailable.",
    );
  }
  if (!capabilities.metadata.bulkHeaders) {
    limitations.push(
      "This provider integration does not inspect bulk-mail headers; newsletter detection is a sender heuristic and is always treated as uncertain.",
    );
  }
  if (action === "archive" || action === "trash") {
    limitations.push(
      "Archiving or moving to Trash does not free provider storage immediately; recovery depends on provider retention.",
    );
  }
  if (providerId === "gmail") {
    limitations.push(
      "Gmail permanent deletion and empty-trash operations are disabled because MailSentry does not request the full-mailbox scope.",
    );
  }
  return limitations;
}

function buildWarnings(options: {
  capabilities: ProviderCapabilities;
  filters: CleanupFilters;
  action: CleanupAction;
  truncated: boolean;
  maxMessages: number;
  uncertainCount: number;
  unknownSizes: number;
}): string[] {
  const warnings: string[] = [];
  if (options.truncated) {
    warnings.push(
      `The scan stopped after ${options.maxMessages} messages; results cover only part of the selected folders. Narrow the filters or raise the bound deliberately.`,
    );
  }
  if (options.uncertainCount > 0) {
    warnings.push(
      `${options.uncertainCount} message(s) could not be classified confidently and are not eligible for cleanup. They are shown for review only.`,
    );
  }
  if (options.unknownSizes > 0) {
    warnings.push(
      `${options.unknownSizes} eligible message(s) have no reliable size; the storage estimate is incomplete.`,
    );
  }
  if (options.filters.bulkOnly) {
    warnings.push(
      options.capabilities.metadata.bulkHeaders
        ? "Bulk classification uses mailing-list headers and sender patterns. Only likely bulk mail is eligible; uncertain matches are excluded."
        : "This provider does not expose bulk-mail headers. Sender-based bulk classification is uncertain, so the bulk filter will not mark messages as eligible.",
    );
  }
  if (options.filters.largeAttachmentBytes !== null) {
    warnings.push(
      "Attachment-size filtering is approximate and only available where the provider exposes reliable attachment metadata.",
    );
  }
  if (options.action === "emptyTrash") {
    warnings.push(
      "Empty Trash ignores age, size, and bulk filters. Protection rules (allowlist, starred, unread, important) still apply. Deletion is permanent.",
    );
  }
  if (ACTION_INFO[options.action].destructive) {
    warnings.push(
      "This action permanently deletes messages and cannot be undone through MailSentry. A second, typed confirmation is required.",
    );
  }
  return warnings;
}

/**
 * Read-only mailbox scan. Fetches metadata page by page, aggregates counts, and
 * retains only message ids plus a bounded preview sample.
 */
export async function scanMailbox(options: ScanOptions): Promise<ScanOutput> {
  const { provider, folders, filters, action, maxMessages, sampleSize } = options;
  const providerId = options.providerId;
  const capabilities = provider.capabilities;
  const now = options.now ?? Date.now();

  if (folders.length === 0) throw new AppError("VALIDATION", "Select at least one folder.", 400);
  for (const folder of folders) {
    if (!capabilities.folders[folder].supported) {
      throw new AppError(
        "FORBIDDEN",
        `${capabilities.displayName} does not support ${folder} cleanup with MailSentry.`,
        403,
      );
    }
  }
  if (!capabilities.actions[action].supported) {
    throw new AppError(
      "FORBIDDEN",
      capabilities.actions[action].reason ?? "This provider does not support the selected action.",
      403,
    );
  }
  assertActionFolders(action, folders);
  assertFiltersUsable(action, filters);
  if (filters.largeAttachmentBytes !== null && !capabilities.metadata.attachmentSize) {
    throw new AppError(
      "VALIDATION",
      "The selected provider does not expose attachment sizes, so attachment-size filtering cannot be used safely. Choose a different filter or provider.",
      400,
    );
  }
  if (action === "emptyTrash" && providerId === "gmail") {
    throw new AppError("FORBIDDEN", capabilities.actions.emptyTrash.reason ?? "Unsupported action.", 403);
  }

  const byFolder: FolderCount[] = folders.map((folder) => ({
    folder,
    displayName: folderDisplayName(capabilities, folder),
    scanned: 0,
    eligible: 0,
    uncertain: 0,
    bytes: 0,
  }));
  const byFolderMap = new Map(byFolder.map((entry) => [entry.folder, entry]));
  const entries: ScanOutput["entries"] = [];
  const sample: PreviewMessage[] = [];
  let scannedCount = 0;
  let uncertainCount = 0;
  let eligibleBytes = 0;
  let unknownSizes = 0;
  let sampleTruncated = false;
  let truncated = false;

  const applyCriteria = action !== "emptyTrash";

  outer: for (const folder of FOLDER_ORDER) {
    if (!folders.includes(folder)) continue;
    let pageToken: string | null = null;
    do {
      if (options.signal?.aborted) throw new AppError("CANCELLED", "The scan was cancelled.", 409);
      const page = await provider.listMessages(folder, pageToken, options.signal);
      for (const message of page.messages) {
        if (scannedCount >= maxMessages) {
          truncated = true;
          break outer;
        }
        scannedCount += 1;
        const folderCount = byFolderMap.get(folder);
        if (folderCount) folderCount.scanned += 1;
        const eligibility = evaluateEligibility(message, filters, now, { applyCriteria });
        if (eligibility.uncertain) {
          uncertainCount += 1;
          if (folderCount) folderCount.uncertain += 1;
        }
        if (!eligibility.eligible) {
          if (eligibility.uncertain && sample.length < sampleSize) {
            sample.push({
              id: message.id,
              folder,
              subject: message.subject,
              from: message.from,
              receivedAt: message.receivedAt,
              sizeBytes: message.sizeBytes,
              bulk: message.bulk,
              uncertain: true,
            });
          }
          continue;
        }
        entries.push({ id: message.id, folder });
        if (folderCount) folderCount.eligible += 1;
        if (message.sizeBytes === null) {
          unknownSizes += 1;
        } else {
          eligibleBytes += message.sizeBytes;
          if (folderCount) folderCount.bytes += message.sizeBytes;
        }
        if (sample.length < sampleSize) {
          sample.push({
            id: message.id,
            folder,
            subject: message.subject,
            from: message.from,
            receivedAt: message.receivedAt,
            sizeBytes: message.sizeBytes,
            bulk: message.bulk,
            uncertain: false,
          });
        } else {
          sampleTruncated = true;
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  const warnings = buildWarnings({
    capabilities,
    filters,
    action,
    truncated,
    maxMessages,
    uncertainCount,
    unknownSizes,
  });
  if (entries.length === 0) {
    warnings.push("No messages matched the selected criteria. Nothing can be executed from this preview.");
  }

  return {
    scannedCount,
    eligibleBytes,
    uncertainCount,
    entries,
    byFolder,
    sample,
    sampleTruncated,
    warnings,
    limitations: limitationsFor(providerId, capabilities, action),
  };
}
