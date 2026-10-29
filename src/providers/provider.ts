import type {
  FolderKind,
  MailFolder,
  MessageMetadata,
  ProviderCapabilities,
  ProviderId,
} from "../shared/types.js";

export type { MailFolder };

export interface ProviderPage {
  messages: MessageMetadata[];
  nextPageToken: string | null;
}

/**
 * Common mailbox interface. Implementations must:
 * - never mutate during list/get;
 * - report capability gaps rather than emulating unsafe operations;
 * - map provider errors to ProviderError so outcomes are classified correctly.
 */
export interface MailProvider {
  readonly id: ProviderId;
  readonly account: string | null;
  readonly capabilities: ProviderCapabilities;
  readonly mode: "readonly" | "cleanup";

  listMessages(folder: FolderKind, pageToken: string | null, signal?: AbortSignal): Promise<ProviderPage>;
  getMessage(id: string, signal?: AbortSignal): Promise<MessageMetadata | null>;

  archive(id: string, signal?: AbortSignal): Promise<void>;
  moveToTrash(id: string, signal?: AbortSignal): Promise<void>;
  permanentlyDelete(id: string, signal?: AbortSignal): Promise<void>;
}

export const FOLDER_ORDER: readonly FolderKind[] = ["inbox", "spam", "trash"];

export function folderLabel(capabilities: ProviderCapabilities, folder: FolderKind): string {
  return capabilities.folders[folder].displayName;
}
