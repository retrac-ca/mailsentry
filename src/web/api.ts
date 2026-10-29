import type {
  ActivityItem,
  AppStatus,
  CleanupJob,
  CleanupPreview,
  DiagnosticReport,
  ProviderConnectionCheck,
  ProviderId,
  RoadmapSection,
  ScanRequest,
  ExecuteRequest,
} from "../shared/types.js";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

let csrfToken = "";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (init.method === "POST" && csrfToken) headers.set("x-csrf-token", csrfToken);
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch {
    throw new ApiError("NETWORK", "The local MailSentry server could not be reached.", 0);
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new ApiError("INVALID_RESPONSE", "The server returned an unreadable response.", response.status);
    }
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? error.code : "HTTP_ERROR";
    const message =
      typeof error?.message === "string" ? error.message : `Request failed (HTTP ${response.status}).`;
    throw new ApiError(code, message, response.status);
  }
  return body as T;
}

export async function loadStatus(): Promise<AppStatus> {
  const status = await request<AppStatus>("/api/status");
  csrfToken = status.csrfToken;
  return status;
}

export async function runDiagnostics(
  domain: string,
  dkimSelector: string,
  signal?: AbortSignal,
): Promise<DiagnosticReport> {
  return request<DiagnosticReport>("/api/diagnostics", {
    method: "POST",
    body: JSON.stringify({ domain, dkimSelector }),
    ...(signal ? { signal } : {}),
  });
}

export async function startAuth(
  provider: "gmail" | "microsoft",
  mode: "readonly" | "cleanup",
): Promise<string> {
  const result = await request<{ authorizeUrl: string }>(`/api/auth/${provider}/start`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
  return result.authorizeUrl;
}

export async function disconnect(provider: "gmail" | "microsoft"): Promise<AppStatus["providers"]> {
  const result = await request<{ providers: AppStatus["providers"] }>(`/api/auth/${provider}/disconnect`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return result.providers;
}

export async function checkProvider(provider: ProviderId): Promise<ProviderConnectionCheck> {
  return request<ProviderConnectionCheck>(`/api/providers/${provider}/check`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function scanMailbox(requestBody: ScanRequest, signal?: AbortSignal): Promise<CleanupPreview> {
  return request<CleanupPreview>("/api/cleanup/scan", {
    method: "POST",
    body: JSON.stringify(requestBody),
    ...(signal ? { signal } : {}),
  });
}

export async function executePlan(body: ExecuteRequest): Promise<CleanupJob> {
  return request<CleanupJob>("/api/cleanup/execute", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getJob(id: string): Promise<CleanupJob> {
  return request<CleanupJob>(`/api/cleanup/jobs/${encodeURIComponent(id)}`);
}

export async function cancelJob(id: string): Promise<CleanupJob> {
  return request<CleanupJob>(`/api/cleanup/jobs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function loadActivity(): Promise<ActivityItem[]> {
  const result = await request<{ items: ActivityItem[] }>("/api/activity");
  return result.items;
}

export async function loadRoadmap(): Promise<RoadmapSection[]> {
  const result = await request<{ sections: RoadmapSection[] }>("/api/roadmap");
  return result.sections;
}
