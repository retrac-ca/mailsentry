import { randomBytes } from "node:crypto";
import { RateLimiter } from "../core/batch.js";
import type { AppConfig } from "../core/config.js";
import type { CleanupJob, DiagnosticReport } from "../shared/types.js";

export interface SessionData {
  id: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  diagnostics: DiagnosticReport[];
  jobs: Map<string, CleanupJob>;
  jobOrder: string[];
  aborts: Map<string, AbortController>;
  diagnosticLimiter: RateLimiter;
}

const MAX_SESSIONS = 200;
const MAX_DIAGNOSTICS = 5;
const MAX_JOBS = 20;

export class SessionStore {
  private readonly sessions = new Map<string, SessionData>();

  constructor(private readonly config: AppConfig) {}

  create(now = Date.now()): SessionData {
    this.prune(now);
    const session: SessionData = {
      id: randomBytes(32).toString("base64url"),
      csrfToken: randomBytes(32).toString("base64url"),
      createdAt: now,
      lastSeenAt: now,
      diagnostics: [],
      jobs: new Map(),
      jobOrder: [],
      aborts: new Map(),
      diagnosticLimiter: new RateLimiter(0.5, 5),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string, now = Date.now()): SessionData | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (now - session.lastSeenAt > this.config.sessionTtlMs) {
      this.destroy(id);
      return undefined;
    }
    session.lastSeenAt = now;
    return session;
  }

  getOrCreate(id: string | null, now = Date.now()): SessionData {
    if (id) {
      const existing = this.get(id, now);
      if (existing) return existing;
    }
    return this.create(now);
  }

  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    for (const controller of session.aborts.values()) controller.abort();
    this.sessions.delete(id);
  }

  prune(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenAt > this.config.sessionTtlMs) this.destroy(id);
    }
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
      if (!oldest) break;
      this.destroy(oldest.id);
    }
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.destroy(id);
  }

  recordDiagnostic(session: SessionData, report: DiagnosticReport): void {
    session.diagnostics.unshift(report);
    session.diagnostics = session.diagnostics.slice(0, MAX_DIAGNOSTICS);
  }

  addJob(session: SessionData, job: CleanupJob): void {
    session.jobs.set(job.id, job);
    session.jobOrder.unshift(job.id);
    while (session.jobOrder.length > MAX_JOBS) {
      const oldest = session.jobOrder.pop();
      if (!oldest) break;
      const existing = session.jobs.get(oldest);
      if (existing && (existing.status === "running" || existing.status === "queued")) {
        session.jobOrder.unshift(oldest);
        break;
      }
      session.jobs.delete(oldest);
      session.aborts.delete(oldest);
    }
  }

  activeJob(session: SessionData): CleanupJob | undefined {
    for (const job of session.jobs.values()) {
      if (job.status === "running" || job.status === "queued") return job;
    }
    return undefined;
  }
}
