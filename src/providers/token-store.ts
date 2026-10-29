import type { AuthMode, ProviderId } from "../shared/types.js";
import type { TokenSet } from "./oauth.js";

export interface ConnectionRecord {
  provider: ProviderId;
  mode: AuthMode;
  account: string | null;
  connectedAt: number;
  connectionId: string;
  tokens: TokenSet;
}

/**
 * Credentials are held in process memory only. They are never written to disk,
 * sent to the browser, or logged. Restarting MailSentry requires reconnecting.
 */
export class ConnectionStore {
  private readonly records = new Map<string, ConnectionRecord>();
  private readonly maxConnections: number;

  constructor(maxConnections = 100) {
    this.maxConnections = maxConnections;
  }

  private key(sessionId: string, provider: ProviderId): string {
    return `${sessionId}:${provider}`;
  }

  get(sessionId: string, provider: ProviderId): ConnectionRecord | undefined {
    return this.records.get(this.key(sessionId, provider));
  }

  set(sessionId: string, provider: ProviderId, record: ConnectionRecord): void {
    if (this.records.size >= this.maxConnections) {
      const oldest = this.records.keys().next().value;
      if (oldest) this.records.delete(oldest);
    }
    this.records.set(this.key(sessionId, provider), record);
  }

  delete(sessionId: string, provider: ProviderId): boolean {
    return this.records.delete(this.key(sessionId, provider));
  }

  deleteSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.records.keys()) {
      if (key.startsWith(prefix)) this.records.delete(key);
    }
  }

  size(): number {
    return this.records.size;
  }
}
