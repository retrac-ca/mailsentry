import { RateLimiter } from "../core/batch.js";
import { capabilitiesFor } from "../core/capabilities.js";
import type {
  AuthMode,
  FolderKind,
  MailFolder,
  MessageMetadata,
  ProviderCapabilities,
} from "../shared/types.js";
import { ProviderError } from "./errors.js";
import { truncate } from "./headers.js";
import { parseJson, providerRequest } from "./http.js";
import type { MailProvider, ProviderPage, FolderProbeResult } from "./provider.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

const SELECT =
  "id,subject,from,receivedDateTime,size,hasAttachments,isRead,isDraft,flag,categories,parentFolderId,importance";

interface GraphEmailAddress {
  emailAddress?: { address?: string; name?: string };
}

interface GraphMessage {
  id?: string;
  subject?: string | null;
  from?: GraphEmailAddress;
  receivedDateTime?: string;
  size?: number;
  hasAttachments?: boolean;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: "notFlagged" | "complete" | "flagged" };
  categories?: string[];
  parentFolderId?: string;
  importance?: "low" | "normal" | "high";
}

interface GraphPage {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
}

interface GraphFolder {
  id?: string;
  displayName?: string;
  wellKnownName?: string;
  totalItemCount?: number;
}

const WELL_KNOWN: Record<FolderKind, string> = {
  inbox: "inbox",
  spam: "junkemail",
  trash: "deleteditems",
};

const BULK_LOCALPART =
  /^(newsletter|newsletters|news|updates?|marketing|promo|promotions?|offers?|digest|mailer|bulk|notifications?)$/i;

export interface MicrosoftProviderOptions {
  accessToken: () => Promise<string>;
  mode: AuthMode;
  account: string | null;
  limiter?: RateLimiter;
}

function safeNextLink(link: string | undefined): string | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new ProviderError("Microsoft Graph returned an invalid pagination link.", {
      code: "INVALID_RESPONSE",
    });
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "graph.microsoft.com" ||
    !url.pathname.startsWith("/v1.0/")
  ) {
    throw new ProviderError("Microsoft Graph returned an unexpected pagination host.", {
      code: "INVALID_RESPONSE",
    });
  }
  return url.toString();
}

export class MicrosoftProvider implements MailProvider {
  readonly id = "microsoft" as const;
  readonly capabilities: ProviderCapabilities = capabilitiesFor("microsoft");
  readonly mode: AuthMode;
  readonly account: string | null;
  private readonly getToken: () => Promise<string>;
  private readonly limiter: RateLimiter;
  private folderCache: Promise<Map<string, FolderKind>> | null = null;
  private destinationCache: Promise<{ archive: string | null; trash: string }> | null = null;

  constructor(options: MicrosoftProviderOptions) {
    this.getToken = options.accessToken;
    this.mode = options.mode;
    this.account = options.account;
    this.limiter = options.limiter ?? new RateLimiter(10, 10);
  }

  private async request<T>(
    pathOrUrl: string,
    init: {
      method?: "GET" | "POST" | "DELETE";
      body?: unknown;
      signal?: AbortSignal;
      idempotent?: boolean;
    } = {},
  ): Promise<T | null> {
    const token = await this.getToken();
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
    const response = await providerRequest({
      provider: "Microsoft Graph",
      method: init.method ?? "GET",
      url,
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
    return parseJson<T>("Microsoft Graph", response);
  }

  private async folderByWellKnown(name: string): Promise<string | null> {
    try {
      const folder = await this.request<GraphFolder>(
        `/me/mailFolders/${encodeURIComponent(name)}?$select=id,displayName,wellKnownName`,
      );
      return folder?.id ?? null;
    } catch (error) {
      if (error instanceof ProviderError && (error.notFound || error.status === 400)) return null;
      throw error;
    }
  }

  private async destinations(): Promise<{ archive: string | null; trash: string }> {
    if (!this.destinationCache) {
      this.destinationCache = (async () => {
        const [archive, trash] = await Promise.all([
          this.folderByWellKnown("archive"),
          this.folderByWellKnown("deleteditems"),
        ]);
        if (!trash) {
          throw new ProviderError("The Deleted Items folder could not be resolved.", {
            code: "INVALID_RESPONSE",
          });
        }
        return { archive, trash };
      })();
    }
    return this.destinationCache;
  }

  /** Map folder ids to tracked kinds so revalidation can detect moves. */
  private async folderMap(): Promise<Map<string, FolderKind>> {
    if (!this.folderCache) {
      this.folderCache = (async () => {
        const map = new Map<string, FolderKind>();
        const [inbox, spam, trash] = await Promise.all([
          this.folderByWellKnown(WELL_KNOWN.inbox),
          this.folderByWellKnown(WELL_KNOWN.spam),
          this.folderByWellKnown(WELL_KNOWN.trash),
        ]);
        if (inbox) map.set(inbox, "inbox");
        if (spam) map.set(spam, "spam");
        if (trash) map.set(trash, "trash");
        return map;
      })();
    }
    return this.folderCache;
  }

  private async folderId(folder: FolderKind): Promise<string> {
    const id = await this.folderByWellKnown(WELL_KNOWN[folder]);
    if (!id) {
      throw new ProviderError(`The ${folder} folder could not be resolved for this account.`, {
        code: "INVALID_RESPONSE",
      });
    }
    return id;
  }

  private async toMetadata(message: GraphMessage, folderHint?: FolderKind): Promise<MessageMetadata | null> {
    if (!message.id) return null;
    let folder: MailFolder = folderHint ?? "other";
    if (!folderHint && message.parentFolderId) {
      folder = (await this.folderMap()).get(message.parentFolderId) ?? "other";
    }
    const from = message.from?.emailAddress?.address ?? null;
    const localPart = from?.split("@")[0]?.toLowerCase() ?? "";
    const received = message.receivedDateTime ? Date.parse(message.receivedDateTime) : Number.NaN;
    return {
      id: message.id,
      folder,
      sizeBytes:
        typeof message.size === "number" && Number.isFinite(message.size) && message.size >= 0
          ? message.size
          : null,
      receivedAt: Number.isFinite(received) ? new Date(received).toISOString() : new Date(0).toISOString(),
      subject: truncate(message.subject ?? null, 200),
      from: truncate(from, 254),
      isRead: message.isRead !== false,
      isStarred: message.flag?.flagStatus === "flagged",
      isImportant: message.importance === "high",
      isDraft: message.isDraft === true,
      hasAttachments: message.hasAttachments === true,
      attachmentBytes: null,
      bulk: BULK_LOCALPART.test(localPart)
        ? {
            level: "possible",
            evidence: `Sender local part "${localPart}" resembles bulk mail; header inspection is not available.`,
          }
        : { level: "none", evidence: null },
    };
  }

  async probeFolder(folder: FolderKind, signal?: AbortSignal): Promise<FolderProbeResult> {
    const id = await this.folderId(folder);
    const folderInfo = await this.request<GraphFolder>(
      `/me/mailFolders/${encodeURIComponent(id)}?$select=id,displayName,totalItemCount`,
      { signal },
    );
    await this.request<GraphPage>(
      `/me/mailFolders/${encodeURIComponent(id)}/messages?$top=1&$select=id,subject`,
      { signal },
    );
    return {
      accessible: Boolean(folderInfo?.id),
      messageCount:
        typeof folderInfo?.totalItemCount === "number" && Number.isFinite(folderInfo.totalItemCount)
          ? folderInfo.totalItemCount
          : null,
    };
  }

  async listMessages(
    folder: FolderKind,
    pageToken: string | null,
    signal?: AbortSignal,
  ): Promise<ProviderPage> {
    const url =
      pageToken ??
      `${GRAPH}/me/mailFolders/${encodeURIComponent(await this.folderId(folder))}/messages?$select=${encodeURIComponent(
        SELECT,
      )}&$top=50`;
    const page = await this.request<GraphPage>(url, { signal });
    if (!page) return { messages: [], nextPageToken: null };
    const messages: MessageMetadata[] = [];
    for (const raw of page.value ?? []) {
      const metadata = await this.toMetadata(raw, folder);
      if (metadata) messages.push(metadata);
    }
    return {
      messages,
      nextPageToken: safeNextLink(page["@odata.nextLink"]),
    };
  }

  async getMessage(id: string, signal?: AbortSignal): Promise<MessageMetadata | null> {
    try {
      const message = await this.request<GraphMessage>(
        `/me/messages/${encodeURIComponent(id)}?$select=${encodeURIComponent(SELECT)}`,
        { signal },
      );
      return message ? this.toMetadata(message) : null;
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
    const { archive } = await this.destinations();
    if (!archive) {
      throw new ProviderError(
        "This mailbox has no Archive folder, so MailSentry cannot archive messages. Use Move to Trash or the provider web interface.",
        { code: "FORBIDDEN" },
      );
    }
    await this.request(`/me/messages/${encodeURIComponent(id)}/move`, {
      method: "POST",
      body: { destinationId: archive },
      signal,
      idempotent: true,
    });
  }

  async moveToTrash(id: string, signal?: AbortSignal): Promise<void> {
    this.assertMutable();
    const { trash } = await this.destinations();
    await this.request(`/me/messages/${encodeURIComponent(id)}/move`, {
      method: "POST",
      body: { destinationId: trash },
      signal,
      idempotent: true,
    });
  }

  async permanentlyDelete(id: string, signal?: AbortSignal): Promise<void> {
    this.assertMutable();
    await this.request(`/me/messages/${encodeURIComponent(id)}/permanentDelete`, {
      method: "POST",
      signal,
      idempotent: true,
    });
  }
}
