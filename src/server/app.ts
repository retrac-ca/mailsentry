import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { ProviderManager } from "../providers/manager.js";
import { ConnectionStore } from "../providers/token-store.js";
import { ProviderError } from "../providers/errors.js";
import { PlanStore, assertExecutionAllowed, type StoredPlan } from "../core/plan.js";
import { scanMailbox } from "../core/scan.js";
import { executeCleanup } from "../core/executor.js";
import { runDiagnostics } from "../diagnostics/index.js";
import { checkProviderConnection } from "../core/connection-check.js";
import type { AppConfig } from "../core/config.js";
import { AppError } from "../core/errors.js";
import type {
  AppStatus,
  CleanupAction,
  CleanupFilters,
  CleanupJob,
  ExecuteRequest,
  ProviderId,
} from "../shared/types.js";
import { APP_NAME, APP_VERSION } from "../shared/version.js";
import { redactString, safeErrorMessage } from "../security/redact.js";
import { createLogger } from "../security/logger.js";
import {
  normalizeDomain,
  normalizeSelector,
  parseAction,
  parseAuthMode,
  parseBoundedInt,
  parseConfirmation,
  parseFilters,
  parseFolders,
  parseProvider,
} from "../security/validation.js";
import {
  applySecurityHeaders,
  parseCookies,
  readJsonBody,
  sendApiError,
  sendHtml,
  sendJson,
} from "./http.js";
import { SessionStore, type SessionData } from "./session.js";
import { buildActivity } from "./activity.js";
import { loadRoadmap } from "./roadmap.js";

const log = createLogger("server");
const COOKIE_NAME = "ms_sid";

interface Asset {
  body: Buffer;
  contentType: string;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function oauthResultPage(title: string, heading: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(
    title,
  )}</title></head><body><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

export interface MailSentryAppHooks {
  /** Desktop mode opens provider authorization in the system browser. */
  openExternal?: (url: string) => Promise<void> | void;
  /** Desktop mode shows a completion page and focuses the app after callback. */
  desktopMode?: boolean;
  onOAuthSuccess?: (provider: ProviderId) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("VALIDATION", "Request body must be a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

export class MailSentryApp {
  private readonly sessions: SessionStore;
  private readonly plans: PlanStore;
  private readonly providers: ProviderManager;
  private assets: Map<string, Asset> | null = null;
  private server: Server | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly rootDir = process.cwd(),
    private readonly hooks: MailSentryAppHooks = {},
  ) {
    this.sessions = new SessionStore(config);
    this.plans = new PlanStore(config.planTtlMs, 3);
    this.providers = new ProviderManager(config, new ConnectionStore());
  }

  private setSessionCookie(res: ServerResponse, sessionId: string): void {
    const secure = this.config.baseUrl.startsWith("https:") ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax${secure}`);
  }

  private getSession(req: IncomingMessage, res: ServerResponse, create: boolean): SessionData | null {
    const cookieId = parseCookies(req.headers.cookie).get(COOKIE_NAME) ?? null;
    let session: SessionData | null = null;
    if (cookieId) session = this.sessions.get(cookieId) ?? null;
    if (!session && create) {
      session = this.sessions.create();
      this.setSessionCookie(res, session.id);
    }
    return session;
  }

  private requireSession(req: IncomingMessage, res: ServerResponse): SessionData {
    const session = this.getSession(req, res, false);
    if (!session) {
      throw new AppError("UNAUTHORIZED", "Your local session expired. Reload the page and try again.", 401);
    }
    return session;
  }

  private assertCsrf(req: IncomingMessage, session: SessionData): void {
    const header = req.headers["x-csrf-token"];
    if (typeof header !== "string" || header.length === 0) {
      throw new AppError("FORBIDDEN", "Missing CSRF token. Reload the page and try again.", 403);
    }
    const expected = Buffer.from(session.csrfToken);
    const actual = Buffer.from(header);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new AppError("FORBIDDEN", "Invalid CSRF token. Reload the page and try again.", 403);
    }
  }

  private assertOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = new Set<string>();
    try {
      const base = new URL(this.config.baseUrl);
      allowed.add(base.origin);
      if (isLoopbackHostname(base.hostname)) {
        const port = base.port || (base.protocol === "https:" ? "443" : "80");
        allowed.add(`${base.protocol}//127.0.0.1:${port}`);
        allowed.add(`${base.protocol}//localhost:${port}`);
      }
      for (const candidate of allowed) {
        if (new URL(origin).origin === new URL(candidate).origin) return;
      }
    } catch {
      // Fall through to rejection.
    }
    throw new AppError("FORBIDDEN", "Cross-origin requests are not accepted.", 403);
  }

  private assertHost(req: IncomingMessage): void {
    const raw = req.headers.host;
    if (!raw) throw new AppError("FORBIDDEN", "Missing Host header.", 421);
    let hostname: string;
    let port: string;
    try {
      const parsed = new URL(`http://${raw}`);
      hostname = parsed.hostname;
      port = parsed.port || "80";
    } catch {
      throw new AppError("FORBIDDEN", "Invalid Host header.", 421);
    }
    const base = new URL(this.config.baseUrl);
    const basePort = base.port || (base.protocol === "https:" ? "443" : "80");
    const hostnameAllowed =
      hostname === base.hostname || (isLoopbackHostname(base.hostname) && isLoopbackHostname(hostname));
    if (!hostnameAllowed || port !== basePort) {
      throw new AppError(
        "FORBIDDEN",
        "Unexpected Host header; DNS-rebinding protection rejected the request.",
        421,
      );
    }
  }

  private async loadAssets(): Promise<Map<string, Asset>> {
    if (this.assets) return this.assets;
    const dir = resolve(this.rootDir, "dist", "public");
    const files: Array<[string, string]> = [
      ["/", "index.html"],
      ["/index.html", "index.html"],
      ["/app.js", "app.js"],
      ["/app.js.map", "app.js.map"],
      ["/styles.css", "styles.css"],
      ["/favicon.svg", "favicon.svg"],
    ];
    const assets = new Map<string, Asset>();
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".map": "application/json; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    for (const [route, file] of files) {
      try {
        const body = await readFile(resolve(dir, file));
        const extension = file.slice(file.lastIndexOf("."));
        assets.set(route, { body, contentType: types[extension] ?? "application/octet-stream" });
      } catch {
        // Optional files (map/favicon) may be absent.
      }
    }
    this.assets = assets;
    return assets;
  }

  private async serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const assets = await this.loadAssets();
    const asset = assets.get(pathname);
    if (!asset) {
      const index = assets.get("/");
      if (!index) {
        sendHtml(
          res,
          503,
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MailSentry not built</title></head><body><h1>MailSentry is not built</h1><p>Run <code>npm run build</code> and restart the server.</p></body></html>',
        );
        return;
      }
      sendHtml(
        res,
        404,
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Not found</h1><p><a href="/">Return to MailSentry</a></p></body></html>',
      );
      return;
    }
    res.writeHead(200, {
      "Content-Type": asset.contentType,
      "Content-Length": asset.body.length,
      "Cache-Control": "no-cache",
    });
    res.end(asset.body);
  }

  private handleProviderError(error: unknown): never {
    if (error instanceof ProviderError) {
      throw new AppError("PROVIDER_ERROR", redactString(error.message), 502);
    }
    throw error;
  }

  private async handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: URLSearchParams,
  ): Promise<boolean> {
    const method = req.method ?? "GET";

    if (pathname === "/api/status" && method === "GET") {
      const session = this.getSession(req, res, true) as SessionData;
      const body: AppStatus = {
        name: APP_NAME,
        version: APP_VERSION,
        baseUrl: this.config.baseUrl,
        csrfToken: session.csrfToken,
        providers: this.providers.status(session.id),
        activity: buildActivity(session),
        privacy: {
          tokenStorage: "In-memory only; credentials are discarded when MailSentry stops or you disconnect.",
          telemetry: false,
          persistence: "Diagnostics and cleanup summaries live in server memory for this session only.",
        },
      };
      sendJson(res, 200, body);
      return true;
    }

    if (pathname === "/api/roadmap" && method === "GET") {
      const sections = await loadRoadmap(this.rootDir);
      sendJson(res, 200, { sections });
      return true;
    }

    if (pathname === "/api/activity" && method === "GET") {
      const session = this.requireSession(req, res);
      sendJson(res, 200, { items: buildActivity(session) });
      return true;
    }

    if (pathname === "/api/diagnostics" && method === "POST") {
      this.requireSession(req, res);
      const session = this.getSession(req, res, false) as SessionData;
      this.assertCsrf(req, session);
      const body = asRecord(await readJsonBody(req));
      const domain = normalizeDomain(body["domain"]);
      const selector = normalizeSelector(body["dkimSelector"] ?? "");
      try {
        await session.diagnosticLimiter.acquire(AbortSignal.timeout(3000));
      } catch {
        throw new AppError(
          "RATE_LIMITED",
          "Too many diagnostic checks. Wait a few seconds and try again.",
          429,
        );
      }
      const report = await runDiagnostics({ domain, dkimSelector: selector });
      this.sessions.recordDiagnostic(session, report);
      log.info("diagnostic completed", {
        domain: report.domain,
        status: report.status,
        findings: report.findings.length,
      });
      sendJson(res, 200, report);
      return true;
    }

    const authRoute = /^\/api\/auth\/(gmail|microsoft)\/(start|disconnect)$/.exec(pathname);
    if (authRoute) {
      const provider = parseProvider(authRoute[1]);
      const action = authRoute[2];
      if (action === "start" && method === "POST") {
        const session = this.requireSession(req, res);
        this.assertCsrf(req, session);
        const body = asRecord(await readJsonBody(req));
        const mode = parseAuthMode(body["mode"]);
        const { authorizeUrl, state } = this.providers.beginAuth(session.id, provider, mode);
        if (this.hooks.openExternal) {
          try {
            await this.hooks.openExternal(authorizeUrl);
          } catch (error) {
            // The browser was never opened; invalidate this request immediately.
            this.providers.cancelAuth(provider, state);
            log.warn("could not open authorization in system browser", { provider, error });
            throw new AppError(
              "PROVIDER_ERROR",
              "Could not open the system browser for authorization. Try again or check the default browser configuration.",
              502,
            );
          }
          sendJson(res, 200, { openedExternally: true });
        } else {
          sendJson(res, 200, { openedExternally: false, authorizeUrl });
        }
        return true;
      }
      if (action === "disconnect" && method === "POST") {
        const session = this.requireSession(req, res);
        this.assertCsrf(req, session);
        this.providers.disconnect(session.id, provider);
        sendJson(res, 200, { providers: this.providers.status(session.id) });
        return true;
      }
      if (method !== "POST") {
        sendJson(res, 405, { error: { code: "METHOD", message: "Method not allowed." } });
        return true;
      }
    }

    const providerCheckRoute = /^\/api\/providers\/(gmail|microsoft)\/check$/.exec(pathname);
    if (providerCheckRoute) {
      if (method !== "POST") {
        sendJson(res, 405, { error: { code: "METHOD", message: "Method not allowed." } });
        return true;
      }
      const providerId = parseProvider(providerCheckRoute[1]);
      const session = this.requireSession(req, res);
      this.assertCsrf(req, session);
      const provider = await this.providers
        .getProvider(session.id, providerId, { needWrite: false })
        .catch(this.handleProviderError);

      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      let result: Awaited<ReturnType<typeof checkProviderConnection>>;
      try {
        result = await checkProviderConnection(provider, { signal: abort.signal });
      } catch (error) {
        if (abort.signal.aborted) {
          throw new AppError("CANCELLED", "The connection check was cancelled.", 409);
        }
        this.handleProviderError(error);
      }
      log.info("provider connection check completed", {
        provider: providerId,
        ok: result.ok,
        folders: result.folders.length,
        mode: result.mode,
      });
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === "/api/cleanup/scan" && method === "POST") {
      const session = this.requireSession(req, res);
      this.assertCsrf(req, session);
      const body = asRecord(await readJsonBody(req));
      const providerId = parseProvider(body["provider"]);
      const folders = parseFolders(body["folders"]);
      const filters: CleanupFilters = parseFilters(body["filters"]);
      const action: CleanupAction = parseAction(body["action"]);
      const maxMessages = parseBoundedInt(
        body["maxMessages"],
        this.config.limits.maxScanMessages,
        100,
        this.config.limits.maxScanMessages,
      );
      const provider = await this.providers
        .getProvider(session.id, providerId, { needWrite: false })
        .catch(this.handleProviderError);
      const connectionToken = this.providers.connectionToken(session.id, providerId);
      if (!connectionToken) {
        throw new AppError("NOT_CONNECTED", "The selected account is not connected.", 401);
      }

      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });

      let scan: Awaited<ReturnType<typeof scanMailbox>>;
      try {
        scan = await scanMailbox({
          provider,
          providerId,
          folders,
          filters,
          action,
          maxMessages,
          pageSize: this.config.limits.pageSize,
          sampleSize: this.config.limits.previewSampleSize,
          signal: abort.signal,
        });
      } catch (error) {
        this.handleProviderError(error);
      }

      const preview = this.plans.create({
        sessionId: session.id,
        connectionToken,
        provider: providerId,
        folders,
        filters,
        action,
        entries: scan.entries,
        scannedCount: scan.scannedCount,
        eligibleBytes: scan.eligibleBytes,
        uncertainCount: scan.uncertainCount,
        byFolder: scan.byFolder,
        sample: scan.sample,
        sampleTruncated: scan.sampleTruncated,
        warnings: scan.warnings,
        limitations: scan.limitations,
        ttlMs: this.config.planTtlMs,
      });
      log.info("scan completed", {
        provider: providerId,
        folders,
        action,
        scanned: scan.scannedCount,
        eligible: scan.entries.length,
      });
      sendJson(res, 200, preview);
      return true;
    }

    if (pathname === "/api/cleanup/execute" && method === "POST") {
      const session = this.requireSession(req, res);
      this.assertCsrf(req, session);
      const body = asRecord(await readJsonBody(req));
      const planId = typeof body["planId"] === "string" ? body["planId"] : "";
      const planHash = typeof body["planHash"] === "string" ? body["planHash"] : "";
      const reviewToken = typeof body["reviewToken"] === "string" ? body["reviewToken"] : "";
      const mode = body["mode"] === "execute" ? "execute" : body["mode"] === "dry-run" ? "dry-run" : null;
      if (!mode) throw new AppError("VALIDATION", "Execution mode must be dry-run or execute.", 400);
      if (!planId || !planHash || !reviewToken) {
        throw new AppError(
          "VALIDATION",
          "The reviewed plan identifier, hash, and review token are required.",
          400,
        );
      }
      const request: ExecuteRequest = {
        planId,
        planHash,
        reviewToken,
        mode,
        ...(body["confirmation"] !== undefined
          ? { confirmation: parseConfirmation(body["confirmation"]) }
          : {}),
      };
      const plan = this.plans.get(planId);
      if (!plan) {
        throw new AppError(
          "NOT_FOUND",
          "This preview is missing or expired. Scan again and review the new preview.",
          404,
        );
      }
      if (plan.ownerSessionId !== session.id) {
        throw new AppError("NOT_FOUND", "This preview does not belong to this session.", 404);
      }
      if (this.providers.connectionToken(session.id, plan.provider) !== plan.connectionToken) {
        throw new AppError(
          "CONFLICT",
          "The connected account or access mode changed after this preview was created. Scan again before executing.",
          409,
        );
      }
      if (plan.provider !== (body["provider"] ?? plan.provider)) {
        throw new AppError("CONFLICT", "The selected provider does not match the reviewed plan.", 409);
      }
      assertExecutionAllowed(plan, request);

      const active = this.sessions.activeJob(session);
      if (active) {
        throw new AppError(
          "CONFLICT",
          "A cleanup job is already running in this session. Wait for it to finish.",
          409,
        );
      }

      const provider = await this.providers
        .getProvider(session.id, plan.provider, { needWrite: mode === "execute" })
        .catch(this.handleProviderError);

      // Consume the plan for real execution only. Dry runs leave it intact so
      // the same reviewed preview can still be executed (or dry-run again).
      const taken = mode === "execute" ? this.plans.take(planId) : this.plans.get(planId);
      if (!taken) {
        throw new AppError("CONFLICT", "This preview was already used. Scan again before executing.", 409);
      }

      const controller = new AbortController();
      const now = new Date().toISOString();
      const job: CleanupJob = {
        id: randomUUID(),
        planId: taken.planId,
        planHash: taken.planHash,
        provider: taken.provider,
        action: taken.action,
        mode,
        status: "running",
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        cancelled: false,
        total: taken.entries.length,
        progress: {
          processed: 0,
          succeeded: 0,
          failed: 0,
          skippedChanged: 0,
          uncertain: 0,
          bytesRecovered: 0,
        },
        batchSize: this.config.limits.executorBatchSize,
        concurrency: this.config.limits.executorConcurrency,
        results: [],
        resultsTruncated: false,
        error: null,
        warnings: [],
      };
      this.sessions.addJob(session, job);
      session.aborts.set(job.id, controller);
      sendJson(res, 202, job);

      void this.runJob(session, job, taken, controller.signal, provider, request.confirmation);
      return true;
    }

    const jobRoute = /^\/api\/cleanup\/jobs\/([A-Za-z0-9-]+)(\/cancel)?$/.exec(pathname);
    if (jobRoute) {
      const session = this.requireSession(req, res);
      const job = session.jobs.get(jobRoute[1] ?? "");
      if (!job) throw new AppError("NOT_FOUND", "Cleanup job not found in this session.", 404);
      if (jobRoute[2] === "/cancel") {
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "METHOD", message: "Method not allowed." } });
          return true;
        }
        this.assertCsrf(req, session);
        const controller = session.aborts.get(job.id);
        if (controller) controller.abort();
        job.cancelled = true;
        if (job.status === "queued") job.status = "cancelled";
        sendJson(res, 202, job);
        return true;
      }
      if (method !== "GET") {
        sendJson(res, 405, { error: { code: "METHOD", message: "Method not allowed." } });
        return true;
      }
      sendJson(res, 200, job);
      return true;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "API route not found." } });
      return true;
    }

    if (pathname === "/auth/gmail/callback" || pathname === "/auth/microsoft/callback") {
      await this.handleOAuthCallback(req, res, pathname, query);
      return true;
    }

    return false;
  }

  private async handleOAuthCallback(
    _req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: URLSearchParams,
  ): Promise<void> {
    const provider = pathname.includes("gmail") ? "gmail" : "microsoft";
    const providerName = provider === "gmail" ? "Gmail" : "Microsoft";
    const state = query.get("state") ?? "";
    const error = query.get("error");
    if (error) {
      this.providers.cancelAuth(provider, state);
      const description = redactString(query.get("error_description") ?? error).slice(0, 200);
      sendHtml(
        res,
        400,
        oauthResultPage(
          "Authorization cancelled",
          "Authorization was not completed",
          `${description} You can return to MailSentry and try again.`,
        ),
      );
      return;
    }
    const code = query.get("code") ?? "";
    try {
      await this.providers.completeAuth(provider, code, state);
      log.info("provider connected", { provider });
      try {
        this.hooks.onOAuthSuccess?.(provider);
      } catch (hookError) {
        log.warn("could not focus MailSentry after authorization", { provider, error: hookError });
      }
      if (this.hooks.desktopMode) {
        sendHtml(
          res,
          200,
          oauthResultPage(
            `${providerName} connected`,
            `${providerName} connected`,
            "You can return to MailSentry. The app window has been brought to the front.",
          ),
        );
      } else {
        res.writeHead(302, { Location: `/?connected=${provider}#/settings`, "Cache-Control": "no-store" });
        res.end();
      }
    } catch (authError) {
      const message =
        authError instanceof AppError ? authError.message : "Authorization could not be completed.";
      sendHtml(
        res,
        400,
        oauthResultPage(
          "Authorization failed",
          "Authorization failed",
          `${message} You can return to MailSentry and start again.`,
        ),
      );
      log.warn("provider authorization failed", { provider, error: authError });
    }
  }

  private async runJob(
    session: SessionData,
    job: CleanupJob,
    plan: StoredPlan,
    signal: AbortSignal,
    provider: Awaited<ReturnType<ProviderManager["getProvider"]>>,
    confirmation: string | undefined,
  ): Promise<void> {
    try {
      const result = await executeCleanup({
        provider,
        plan,
        mode: job.mode,
        batchSize: this.config.limits.executorBatchSize,
        concurrency: this.config.limits.executorConcurrency,
        resultsSampleSize: this.config.limits.resultsSampleSize,
        signal,
        confirmation,
        onProgress: (progress) => {
          job.progress = { ...progress };
        },
      });
      job.progress = { ...result.progress };
      job.results = result.results;
      job.resultsTruncated = result.resultsTruncated;
      job.warnings = result.warnings;
      job.cancelled = result.cancelled;
      job.error = result.fatalError;
      job.status = result.cancelled ? "cancelled" : result.fatalError ? "failed" : "completed";
      log.info("cleanup finished", {
        provider: job.provider,
        action: job.action,
        mode: job.mode,
        status: job.status,
        total: job.total,
        succeeded: job.progress.succeeded,
        failed: job.progress.failed,
        skipped: job.progress.skippedChanged,
        uncertain: job.progress.uncertain,
      });
    } catch (error) {
      job.status = "failed";
      job.error = safeErrorMessage(error);
      log.error("cleanup job crashed", { jobId: job.id, error });
    } finally {
      job.finishedAt = new Date().toISOString();
      session.aborts.delete(job.id);
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applySecurityHeaders(res);
    try {
      this.assertHost(req);
      const method = req.method ?? "GET";
      if (method === "POST") this.assertOrigin(req);
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const handled = await this.handleApi(req, res, url.pathname, url.searchParams);
      if (handled) return;
      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { error: { code: "METHOD", message: "Method not allowed." } });
        return;
      }
      await this.serveStatic(res, url.pathname);
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        log.debug("request rejected", { code: error.code });
      } else {
        log.error("request failed", { error });
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      sendApiError(res, error);
    }
  }

  start(): Promise<Server> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.headersTimeout = 20_000;
    this.server.requestTimeout = 0;
    return new Promise((resolvePromise, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.port, this.config.host, () => {
        this.server?.removeListener("error", reject);
        resolvePromise(this.server as Server);
      });
    });
  }

  async stop(): Promise<void> {
    this.sessions.closeAll();
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeAllConnections();
    });
    this.server = null;
  }

  hasActiveJobs(): boolean {
    return this.sessions.hasActiveJobs();
  }
}
