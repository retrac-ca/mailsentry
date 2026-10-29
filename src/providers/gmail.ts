import { mapConcurrent } from "../core/batch.js";
import { capabilitiesFor } from "../core/capabilities.js";
import type {
  AuthMode,
  FolderKind,
  MailFolder,
  MessageMetadata,
  ProviderCapabilities,
} from "../shared/types.js";
import { ProviderError } from "./errors.js";
import { decodeHeaderValue, truncate } from "./headers.js";
import { parseJson, providerRequest, type ProviderResponse } from "./http.js";
import type { MailProvider, ProviderPage, FolderProbeResult } from "./provider.js";
import { RateLimiter } from "../core/batch.js";

const API = "https://gmail.googleapis.com/gmail/v1";

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMessage {
  id?: string;
  labelIds?: string[];
  internalDate?: string;
  sizeEstimate?: number;
  payload?: { headers?: GmailHeader[] };
}

interface GmailList {
  messages?: Array<{ id?: string }>;
  nextPageToken?: string;
}

interface GmailProfile {
  emailAddress?: string;
}

export interface GmailProviderOptions {
  accessToken: () => Promise<string>;
  mode: AuthMode;
  account: string | null;
  limiter?: RateLimiter;
}

const LABEL_FOR_FOLDER: Record<FolderKind, string> = {
  inbox: "INBOX",
  spam: "SPAM",
  trash: "TRASH",
};

const BULK_LOCALPART =
  /^(newsletter|newsletters|news|updates?|marketing|promo|promotions?|offers?|digest|mailer|bulk|notifications?)$/i;

function headerMap(message: GmailMessage): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of message.payload?.headers ?? []) {
    if (!header.name) continue;
    const key = header.name.toLowerCase();
    if (!map.has(key) && typeof header.value === "string") map.set(key, header.value);
  }
  return map;
}

function classifyBulk(headers: Map<string, string>, from: string | null): MessageMetadata["bulk"] {
  if (headers.has("list-unsubscribe") || headers.has("list-id")) {
    return { level: "likely", evidence: "Mailing-list headers present (List-Unsubscribe/List-Id)." };
  }
  const precedence = headers.get("precedence")?.toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    return { level: "likely", evidence: `Precedence: ${precedence} header present.` };
  }
  const localPart = from?.split("@")[0]?.toLowerCase() ?? "";
  if (BULK_LOCALPART.test(localPart)) {
    return { level: "possible", evidence: `Sender local part "${localPart}" resembles bulk mail.` };
  }
  return { level: "none", evidence: null };
}

function folderFromLabels(labels: string[]): MailFolder {
  if (labels.includes("TRASH")) return "trash";
  if (labels.includes("SPAM")) return "spam";
  if (labels.includes("INBOX")) return "inbox";
  return "other";
}

function toMetadata(message: GmailMessage): MessageMetadata | null {
  if (!message.id) return null;
  const labels = message.labelIds ?? [];
  const headers = headerMap(message);
  const from = truncate(decodeHeaderValue(headers.get("from") ?? null), 254);
  const receivedMs = Number(message.internalDate);
  const receivedAt =
    Number.isFinite(receivedMs) && receivedMs > 0
      ? new Date(receivedMs).toISOString()
      : new Date(0).toISOString();

  return {
    id: message.id,
    folder: folderFromLabels(labels),
    sizeBytes:
      typeof message.sizeEstimate === "number" && Number.isFinite(message.sizeEstimate)
        ? message.sizeEstimate
        : null,
    receivedAt,
    subject: truncate(decodeHeaderValue(headers.get("subject") ?? null), 200),
    from,
    isRead: !labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
    isImportant: labels.includes("IMPORTANT"),
    isDraft: labels.includes("DRAFT"),
    hasAttachments: false,
    attachmentBytes: null,
    bulk: classifyBulk(headers, from),
  };
}

export class GmailProvider implements MailProvider {
  readonly id = "gmail" as const;
  readonly capabilities: ProviderCapabilities = capabilitiesFor("gmail");
  readonly mode: AuthMode;
  readonly account: string | null;
  private readonly getToken: () => Promise<string>;
  private readonly limiter: RateLimiter;

  constructor(options: GmailProviderOptions) {
    this.getToken = options.accessToken;
    this.mode = options.mode;
    this.account = options.account;
    this.limiter = options.limiter ?? new RateLimiter(20, 20);
  }

  private async request<T>(
    path: string,
    init: { method?: "GET" | "POST"; signal?: AbortSignal; body?: unknown; idempotent?: boolean } = {},
  ): Promise<T | null> {
    const token = await this.getToken();
    const response: ProviderResponse = await providerRequest({
      provider: "Gmail",
      method: init.method ?? "GET",
      url: `${API}${path}`,
      headers:
        init.body === undefined
          ? { Authorization: `Bearer ${token}` }
          : { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: init.signal,
      limiter: this.limiter,
      idempotent: init.idempotent ?? (init.method ?? "GET") === "GET",
    });
    if (response.text.trim() === "") return null;
    return parseJson<T>("Gmail", response);
  }

  private async fetchMetadata(id: string, signal?: AbortSignal): Promise<MessageMetadata | null> {
    const message = await this.request<GmailMessage>(
      `/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Id&metadataHeaders=Precedence&fields=id,labelIds,internalDate,sizeEstimate,payload/headers`,
      { signal },
    );
    return message ? toMetadata(message) : null;
  }

  async probeFolder(folder: FolderKind, signal?: AbortSignal): Promise<FolderProbeResult> {
    const query = new URLSearchParams({
      labelIds: LABEL_FOR_FOLDER[folder],
      maxResults: "1",
      fields: "messages/id",
    });
    const page = await this.request<GmailList>(`/users/me/messages?${query.toString()}`, { signal });
    const firstId = page?.messages?.find((entry) => entry.id)?.id;
    if (firstId) {
      try {
        await this.fetchMetadata(firstId, signal);
      } catch (error) {
        if (!(error instanceof ProviderError && error.notFound)) throw error;
      }
    }
    return { accessible: true, messageCount: null };
  }

  async listMessages(
    folder: FolderKind,
    pageToken: string | null,
    signal?: AbortSignal,
  ): Promise<ProviderPage> {
    const query = new URLSearchParams({
      labelIds: LABEL_FOR_FOLDER[folder],
      maxResults: "50",
      fields: "messages/id,nextPageToken",
    });
    if (pageToken) query.set("pageToken", pageToken);
    const page = await this.request<GmailList>(`/users/me/messages?${query.toString()}`, { signal });
    if (!page) return { messages: [], nextPageToken: null };
    const ids = (page.messages ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const results = await mapConcurrent(
      ids,
      4,
      async (id) => {
        try {
          return await this.fetchMetadata(id, signal);
        } catch (error) {
          if (error instanceof ProviderError && error.notFound) return null;
          throw error;
        }
      },
      signal,
    );
    const messages = results.filter(
      (entry): entry is MessageMetadata => entry !== undefined && entry !== null,
    );
    return {
      messages: messages.map((message) => ({ ...message, folder })),
      nextPageToken: page.nextPageToken ?? null,
    };
  }

  async getMessage(id: string, signal?: AbortSignal): Promise<MessageMetadata | null> {
    try {
      return await this.fetchMetadata(id, signal);
    } catch (error) {
      if (error instanceof ProviderError && error.notFound) return null;
      throw error;
    }
  }

  private assertMutable(): void {
    if (this.mode !== "cleanup") {
      throw new ProviderError(
        "This account was connected with read-only access. Reconnect with cleanup access to modify messages.",
        { code: "FORBIDDEN" },
      );
    }
  }

  async archive(id: string, signal?: AbortSignal): Promise<void> {
    this.assertMutable();
    await this.request(`/users/me/messages/${encodeURIComponent(id)}/modify`, {
      method: "POST",
      body: { removeLabelIds: ["INBOX"] },
      signal,
      idempotent: true,
    });
  }

  async moveToTrash(id: string, signal?: AbortSignal): Promise<void> {
    this.assertMutable();
    await this.request(`/users/me/messages/${encodeURIComponent(id)}/trash`, {
      method: "POST",
      signal,
      idempotent: true,
    });
  }

  async permanentlyDelete(_id: string, _signal?: AbortSignal): Promise<void> {
    throw new ProviderError(
      "Gmail permanent deletion requires the full-mailbox scope, which MailSentry does not request.",
      { code: "FORBIDDEN" },
    );
  }
}

export async function fetchGmailAccount(accessToken: string, limiter: RateLimiter): Promise<string | null> {
  try {
    const response = await providerRequest({
      provider: "Gmail",
      url: `${API}/users/me/profile?fields=emailAddress`,
      headers: { Authorization: `Bearer ${accessToken}` },
      limiter,
      timeoutMs: 10_000,
    });
    const profile = parseJson<GmailProfile>("Gmail", response);
    return profile.emailAddress ?? null;
  } catch {
    return null;
  }
}
