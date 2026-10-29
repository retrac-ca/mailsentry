import { randomBytes } from "node:crypto";
import { RateLimiter } from "../core/batch.js";
import type { AppConfig } from "../core/config.js";
import { AppError } from "../core/errors.js";
import { capabilitiesFor } from "../core/capabilities.js";
import type { AuthMode, ProviderConnectionStatus, ProviderId } from "../shared/types.js";
import { GmailProvider, fetchGmailAccount } from "./gmail.js";
import { MicrosoftProvider } from "./microsoft.js";
import {
  accountFromIdToken,
  GoogleOAuthClient,
  MicrosoftOAuthClient,
  pkcePair,
  type OAuthClient,
  type TokenSet,
} from "./oauth.js";
import type { ConnectionStore, ConnectionRecord } from "./token-store.js";
import type { MailProvider } from "./provider.js";
import { ProviderError } from "./errors.js";

interface PendingAuth {
  sessionId: string;
  provider: ProviderId;
  mode: AuthMode;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

const AUTH_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 50;

export class ProviderManager {
  private readonly pending = new Map<string, PendingAuth>();
  private readonly refreshing = new Map<string, Promise<ConnectionRecord>>();
  private readonly limiters = {
    gmail: new RateLimiter(20, 20),
    microsoft: new RateLimiter(10, 10),
  };
  private readonly googleOAuth = new GoogleOAuthClient();
  private readonly microsoftOAuth: MicrosoftOAuthClient;

  constructor(
    private readonly config: AppConfig,
    private readonly connections: ConnectionStore,
  ) {
    this.microsoftOAuth = new MicrosoftOAuthClient(config.microsoft.tenant);
  }

  isConfigured(provider: ProviderId): boolean {
    return provider === "gmail"
      ? Boolean(this.config.google.clientId)
      : Boolean(this.config.microsoft.clientId);
  }

  scopes(provider: ProviderId, mode: AuthMode): string {
    const caps = capabilitiesFor(provider);
    if (provider === "gmail") {
      return mode === "readonly" ? caps.auth.readonlyScope : caps.auth.cleanupScope;
    }
    const mailScope = mode === "readonly" ? caps.auth.readonlyScope : caps.auth.cleanupScope;
    return `offline_access openid profile email ${mailScope}`;
  }

  private oauth(provider: ProviderId): OAuthClient {
    return provider === "gmail" ? this.googleOAuth : this.microsoftOAuth;
  }

  private credentials(provider: ProviderId) {
    const config = provider === "gmail" ? this.config.google : this.config.microsoft;
    if (!config.clientId) {
      throw new AppError(
        "NOT_CONFIGURED",
        `${provider === "gmail" ? "Gmail" : "Microsoft"} OAuth is not configured. Set the client ID in .env and restart.`,
        400,
      );
    }
    return {
      clientId: config.clientId,
      ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    };
  }

  setupHint(provider: ProviderId): string {
    if (provider === "gmail") {
      return "Create a Google OAuth client (Web application), register /auth/gmail/callback, and set GOOGLE_CLIENT_ID. See docs/PROVIDERS.md.";
    }
    return "Register an app in Microsoft Entra ID, add the redirect URI /auth/microsoft/callback, and set MICROSOFT_CLIENT_ID. See docs/PROVIDERS.md.";
  }

  status(sessionId: string): ProviderConnectionStatus[] {
    return (["gmail", "microsoft"] as const).map((provider) => {
      const record = this.connections.get(sessionId, provider);
      return {
        provider,
        displayName: provider === "gmail" ? "Gmail" : "Microsoft 365 / Outlook",
        configured: this.isConfigured(provider),
        connected: Boolean(record),
        mode: record?.mode ?? null,
        connectedAt: record ? new Date(record.connectedAt).toISOString() : null,
        account: record?.account ?? null,
        capabilities: capabilitiesFor(provider),
        setupHint: this.setupHint(provider),
      };
    });
  }

  private prunePending(): void {
    const cutoff = Date.now() - AUTH_TTL_MS;
    for (const [state, entry] of this.pending) {
      if (entry.createdAt < cutoff) this.pending.delete(state);
    }
    if (this.pending.size >= MAX_PENDING) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.pending.delete(oldest[0]);
    }
  }

  beginAuth(sessionId: string, provider: ProviderId, mode: AuthMode): { authorizeUrl: string } {
    this.prunePending();
    const credentials = this.credentials(provider);
    const state = randomBytes(24).toString("base64url");
    const { verifier, challenge } = pkcePair();
    const redirectUri = `${this.config.baseUrl}/auth/${provider}/callback`;
    const authorizeUrl = this.oauth(provider).buildAuthorizeUrl({
      credentials,
      redirectUri,
      scopes: this.scopes(provider, mode),
      state,
      codeChallenge: challenge,
    });
    this.pending.set(state, {
      sessionId,
      provider,
      mode,
      verifier,
      redirectUri,
      createdAt: Date.now(),
    });
    return { authorizeUrl };
  }

  async completeAuth(
    sessionId: string,
    provider: ProviderId,
    code: string,
    state: string,
  ): Promise<{ provider: ProviderId; mode: AuthMode; account: string | null }> {
    const pending = this.pending.get(state);
    if (!pending || pending.createdAt < Date.now() - AUTH_TTL_MS) {
      this.pending.delete(state);
      throw new AppError("FORBIDDEN", "The authorization request is unknown or expired. Start again.", 400);
    }
    // Single-use state; delete before exchanging to prevent replay.
    this.pending.delete(state);
    if (pending.provider !== provider || pending.sessionId !== sessionId) {
      throw new AppError("FORBIDDEN", "The authorization response did not match this session.", 400);
    }
    if (!code) throw new AppError("VALIDATION", "The authorization code is missing.", 400);

    const tokens = await this.oauth(provider).exchangeCode({
      credentials: this.credentials(provider),
      redirectUri: pending.redirectUri,
      code,
      codeVerifier: pending.verifier,
      scopes: this.scopes(provider, pending.mode),
    });

    const account =
      provider === "gmail"
        ? await fetchGmailAccount(tokens.accessToken, this.limiters.gmail)
        : accountFromIdToken(tokens.idToken);

    this.connections.set(sessionId, provider, {
      provider,
      mode: pending.mode,
      account,
      connectedAt: Date.now(),
      connectionId: randomBytes(16).toString("base64url"),
      tokens,
    });
    return { provider, mode: pending.mode, account };
  }

  /** Identifies the exact connected account/mode; plans are bound to this value. */
  connectionToken(sessionId: string, provider: ProviderId): string | null {
    return this.connections.get(sessionId, provider)?.connectionId ?? null;
  }

  disconnect(sessionId: string, provider: ProviderId): void {
    this.connections.delete(sessionId, provider);
  }

  private async refresh(
    key: string,
    sessionId: string,
    provider: ProviderId,
    record: ConnectionRecord,
  ): Promise<ConnectionRecord> {
    const inFlight = this.refreshing.get(key);
    if (inFlight) return inFlight;
    const refreshToken = record.tokens.refreshToken;
    if (!refreshToken) {
      this.connections.delete(sessionId, provider);
      throw new AppError("NOT_CONNECTED", "Authorization expired. Reconnect the account.", 401);
    }
    const task = (async () => {
      try {
        const tokens: TokenSet = await this.oauth(provider).refresh(
          refreshToken,
          this.credentials(provider),
          this.scopes(provider, record.mode),
        );
        const updated: ConnectionRecord = { ...record, tokens };
        this.connections.set(sessionId, provider, updated);
        return updated;
      } catch {
        this.connections.delete(sessionId, provider);
        throw new AppError(
          "NOT_CONNECTED",
          "Authorization expired and could not be refreshed. Reconnect the account.",
          401,
        );
      }
    })();
    this.refreshing.set(key, task);
    try {
      return await task;
    } finally {
      this.refreshing.delete(key);
    }
  }

  async getProvider(
    sessionId: string,
    provider: ProviderId,
    options: { needWrite: boolean },
  ): Promise<MailProvider> {
    if (!this.isConfigured(provider)) this.credentials(provider);
    let record = this.connections.get(sessionId, provider);
    if (!record) {
      throw new AppError(
        "NOT_CONNECTED",
        `Connect ${provider === "gmail" ? "Gmail" : "Microsoft"} before using mailbox features.`,
        401,
      );
    }
    if (options.needWrite && record.mode !== "cleanup") {
      throw new AppError(
        "FORBIDDEN",
        "This account was connected read-only. Reconnect with cleanup access before executing changes.",
        403,
      );
    }

    const key = `${sessionId}:${provider}`;
    if (record.tokens.expiresAt - 30_000 <= Date.now()) {
      record = await this.refresh(key, sessionId, provider, record);
    }

    const tokenAccessor = async (): Promise<string> => {
      const current = this.connections.get(sessionId, provider);
      if (!current) {
        throw new ProviderError("Authorization is no longer available. Reconnect the account.", {
          code: "UNAUTHORIZED",
        });
      }
      if (current.tokens.expiresAt - 30_000 <= Date.now()) {
        try {
          const refreshed = await this.refresh(key, sessionId, provider, current);
          return refreshed.tokens.accessToken;
        } catch {
          throw new ProviderError("Authorization expired. Reconnect the account.", {
            code: "UNAUTHORIZED",
          });
        }
      }
      return current.tokens.accessToken;
    };

    if (provider === "gmail") {
      return new GmailProvider({
        accessToken: tokenAccessor,
        mode: record.mode,
        account: record.account,
        limiter: this.limiters.gmail,
      });
    }
    return new MicrosoftProvider({
      accessToken: tokenAccessor,
      mode: record.mode,
      account: record.account,
      limiter: this.limiters.microsoft,
    });
  }
}
