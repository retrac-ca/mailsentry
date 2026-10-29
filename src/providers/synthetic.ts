import type {
  AuthMode,
  CleanupAction,
  FolderKind,
  MessageMetadata,
  ProviderCapabilities,
  ProviderId,
} from "../shared/types.js";
import { capabilitiesFor } from "../core/capabilities.js";
import { ProviderError } from "./errors.js";
import type { MailProvider, ProviderPage, FolderProbeResult } from "./provider.js";

/**
 * Synthetic provider used exclusively by tests and the memory benchmark.
 * It is never registered with the HTTP application and never contacts a network.
 */
export interface MutationCall {
  action: CleanupAction;
  id: string;
}

export interface SyntheticFailure {
  operation: "list" | "get" | "archive" | "trash" | "permanentDelete";
  id?: string;
  times: number;
  error: ProviderError;
}

export interface SyntheticProviderOptions {
  mode?: AuthMode;
  pageSize?: number;
  latencyMs?: number;
  mutationDelayMs?: number;
  capabilities?: ProviderCapabilities;
  failures?: SyntheticFailure[];
}

export class SyntheticProvider implements MailProvider {
  readonly capabilities: ProviderCapabilities;
  readonly mode: AuthMode;
  readonly account = "synthetic@example.test";
  readonly id: ProviderId;
  private readonly mailbox: Map<string, MessageMetadata>;
  private readonly pageSize: number;
  private readonly latencyMs: number;
  private readonly mutationDelayMs: number;
  private failures: SyntheticFailure[];
  private readonly calls = {
    list: 0,
    get: 0,
    archive: 0,
    trash: 0,
    permanentDelete: 0,
  };
  private readonly mutationLog: MutationCall[] = [];

  constructor(
    messages: MessageMetadata[],
    options: SyntheticProviderOptions & { providerId?: ProviderId } = {},
  ) {
    this.mailbox = new Map(messages.map((message) => [message.id, { ...message }]));
    this.pageSize = options.pageSize ?? 50;
    this.latencyMs = options.latencyMs ?? 0;
    this.mutationDelayMs = options.mutationDelayMs ?? 0;
    this.mode = options.mode ?? "cleanup";
    this.id = options.providerId ?? "gmail";
    this.capabilities = options.capabilities ?? capabilitiesFor(this.id);
    this.failures = options.failures ?? [];
  }

  getCallCounts(): Readonly<typeof this.calls> {
    return { ...this.calls };
  }

  getMutations(): readonly MutationCall[] {
    return this.mutationLog;
  }

  getMessageIds(): string[] {
    return [...this.mailbox.keys()];
  }

  setMessage(id: string, patch: Partial<MessageMetadata>): void {
    const existing = this.mailbox.get(id);
    if (existing) this.mailbox.set(id, { ...existing, ...patch });
  }

  removeMessage(id: string): void {
    this.mailbox.delete(id);
  }

  addMessage(message: MessageMetadata): void {
    this.mailbox.set(message.id, { ...message });
  }

  private maybeFail(operation: SyntheticFailure["operation"], id?: string): void {
    const failure = this.failures.find(
      (entry) =>
        entry.operation === operation && entry.times > 0 && (entry.id === undefined || entry.id === id),
    );
    if (!failure) return;
    failure.times -= 1;
    this.failures = this.failures.filter((entry) => entry.times > 0 || entry !== failure);
    throw failure.error;
  }

  private async pace(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return;
    }
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async probeFolder(folder: FolderKind, signal?: AbortSignal): Promise<FolderProbeResult> {
    await this.pace(this.latencyMs, signal);
    this.maybeFail("list");
    const count = [...this.mailbox.values()].filter((message) => message.folder === folder).length;
    return { accessible: true, messageCount: count };
  }

  async listMessages(
    folder: FolderKind,
    pageToken: string | null,
    signal?: AbortSignal,
  ): Promise<ProviderPage> {
    this.calls.list += 1;
    await this.pace(this.latencyMs, signal);
    this.maybeFail("list");
    const all = [...this.mailbox.values()].filter((message) => message.folder === folder);
    const offset = pageToken ? Number.parseInt(pageToken, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ProviderError("Bad synthetic page token.", { code: "INVALID_RESPONSE" });
    }
    const slice = all.slice(offset, offset + this.pageSize).map((message) => ({ ...message }));
    const next = offset + this.pageSize < all.length ? String(offset + this.pageSize) : null;
    return { messages: slice, nextPageToken: next };
  }

  async getMessage(id: string, signal?: AbortSignal): Promise<MessageMetadata | null> {
    this.calls.get += 1;
    await this.pace(this.latencyMs, signal);
    this.maybeFail("get", id);
    const message = this.mailbox.get(id);
    return message ? { ...message } : null;
  }

  private assertMutable(): void {
    if (this.mode !== "cleanup") {
      throw new ProviderError("Synthetic provider is read-only.", { code: "FORBIDDEN" });
    }
  }

  private applyMutation(action: "archive" | "trash" | "permanentDelete", id: string): void {
    this.calls[action] += 1;
    this.mutationLog.push({ action, id });
    const message = this.mailbox.get(id);
    if (!message) throw new ProviderError("Message not found.", { code: "NOT_FOUND", notFound: true });
    if (action === "archive") {
      this.mailbox.set(id, { ...message, folder: "other" });
      return;
    }
    if (action === "trash") {
      if (message.folder === "trash") return;
      this.mailbox.set(id, { ...message, folder: "trash" });
      return;
    }
    this.mailbox.delete(id);
  }

  async archive(id: string, signal?: AbortSignal): Promise<void> {
    this.assertMutable();
    await this.pace(this.mutationDelayMs, signal);
    this.maybeFail("archive", id);
    this.applyMutation("archive", id);
  }

  async moveToTrash(id: string, signal?: AbortSignal): Promise<void> {
    this.assertMutable();
    await this.pace(this.mutationDelayMs, signal);
    this.maybeFail("trash", id);
    this.applyMutation("trash", id);
  }

  async permanentlyDelete(id: string, signal?: AbortSignal): Promise<void> {
    this.assertMutable();
    await this.pace(this.mutationDelayMs, signal);
    this.maybeFail("permanentDelete", id);
    this.applyMutation("permanentDelete", id);
  }
}

export function syntheticMessage(id: string, overrides: Partial<MessageMetadata> = {}): MessageMetadata {
  const received = new Date(Date.now() - 400 * 86_400_000).toISOString();
  return {
    id,
    folder: "inbox",
    sizeBytes: 25_000,
    receivedAt: received,
    subject: `Synthetic message ${id}`,
    from: "sender@example.test",
    isRead: true,
    isStarred: false,
    isImportant: false,
    isDraft: false,
    hasAttachments: false,
    attachmentBytes: null,
    bulk: { level: "none", evidence: null },
    ...overrides,
  };
}
