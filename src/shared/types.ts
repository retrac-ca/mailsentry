/**
 * Shared contracts between the server, core and browser client.
 * Nothing in this file may contain secrets or provider-specific logic.
 */

export type Severity = "pass" | "info" | "warning" | "critical";
export type Confidence = "confirmed" | "inconclusive";

export type DiagnosticCheck = "mx" | "spf" | "dkim" | "dmarc";

export interface DiagnosticFinding {
  id: string;
  check: DiagnosticCheck;
  severity: Severity;
  title: string;
  observed: string;
  whyItMatters: string;
  recommendation: string;
  confidence: Confidence;
}

export interface DiagnosticReport {
  domain: string;
  checkedAt: string;
  dkimSelector: string | null;
  status: "ok" | "partial" | "failed";
  findings: DiagnosticFinding[];
  /** Raw-ish observations, already bounded in size. Never includes credentials. */
  observations: Record<string, string[]>;
  limitations: string[];
}

export type ProviderId = "gmail" | "microsoft";
export type FolderKind = "inbox" | "spam" | "trash";
/** "other" means the message is no longer in a tracked folder (e.g. archived). */
export type MailFolder = FolderKind | "other";
export type CleanupAction = "archive" | "trash" | "permanentDelete" | "emptyTrash";
export type AuthMode = "readonly" | "cleanup";

export interface CapabilitySupport {
  supported: boolean;
  reason?: string;
  confirmationRequired: boolean;
}

export interface ProviderCapabilities {
  provider: ProviderId;
  displayName: string;
  folders: Record<FolderKind, CapabilitySupport & { displayName: string }>;
  actions: Record<CleanupAction, CapabilitySupport>;
  metadata: {
    messageSize: boolean;
    attachmentSize: boolean;
    bulkHeaders: boolean;
  };
  auth: {
    readonlyScope: string;
    cleanupScope: string;
  };
}

export interface BulkClassification {
  level: "none" | "possible" | "likely";
  evidence: string | null;
}

export interface MessageMetadata {
  id: string;
  folder: MailFolder;
  sizeBytes: number | null;
  receivedAt: string;
  subject: string | null;
  from: string | null;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
  attachmentBytes: number | null;
  bulk: BulkClassification;
}

export interface CleanupFilters {
  /** Minimum age in days. 0 disables the age criterion. */
  minAgeDays: number;
  /** Minimum RFC-ish byte size. null disables. */
  minSizeBytes: number | null;
  /**
   * Minimum attachment size. Providers that cannot report attachment sizes
   * will mark matching messages as uncertain instead of eligible.
   */
  largeAttachmentBytes: number | null;
  /** Only messages classified as likely/possible bulk mail. */
  bulkOnly: boolean;
  /** Senders that are never eligible (address or domain). */
  senderAllowlist: string[];
  /** If non-empty, only these senders/domains are eligible. */
  senderTargets: string[];
  /** Protection defaults: all false means protected messages are excluded. */
  includeStarred: boolean;
  includeUnread: boolean;
  includeImportant: boolean;
}

export interface Eligibility {
  eligible: boolean;
  uncertain: boolean;
  reasons: string[];
  sizeBytes: number | null;
}

export interface PreviewMessage {
  id: string;
  folder: FolderKind;
  subject: string | null;
  from: string | null;
  receivedAt: string;
  sizeBytes: number | null;
  bulk: BulkClassification;
  uncertain: boolean;
}

export interface FolderCount {
  folder: FolderKind;
  displayName: string;
  scanned: number;
  eligible: number;
  uncertain: number;
  bytes: number;
}

export interface ActionInfo {
  action: CleanupAction;
  label: string;
  description: string;
  destructive: boolean;
  reversible: boolean;
  /** Exact phrase required for irreversible actions; null otherwise. */
  confirmationPhrase: string | null;
}

export interface CleanupPreview {
  planId: string;
  planHash: string;
  reviewToken: string;
  createdAt: string;
  expiresAt: string;
  provider: ProviderId;
  folders: FolderKind[];
  filters: CleanupFilters;
  action: CleanupAction;
  actionInfo: ActionInfo;
  scannedCount: number;
  eligibleCount: number;
  eligibleBytes: number;
  uncertainCount: number;
  byFolder: FolderCount[];
  sample: PreviewMessage[];
  sampleTruncated: boolean;
  warnings: string[];
  limitations: string[];
}

export interface ScanRequest {
  provider: ProviderId;
  folders: FolderKind[];
  filters: CleanupFilters;
  action: CleanupAction;
  maxMessages?: number;
}

export interface ExecuteRequest {
  planId: string;
  planHash: string;
  reviewToken: string;
  mode: "dry-run" | "execute";
  confirmation?: string;
}

export type JobStatus = "queued" | "running" | "completed" | "cancelled" | "failed";

export type JobOutcome = "succeeded" | "failed" | "skipped-changed" | "uncertain";

export interface JobMessageResult {
  id: string;
  subject: string | null;
  from: string | null;
  outcome: JobOutcome;
  detail: string;
}

export interface CleanupJob {
  id: string;
  planId: string;
  planHash: string;
  provider: ProviderId;
  action: CleanupAction;
  mode: "dry-run" | "execute";
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelled: boolean;
  total: number;
  progress: {
    processed: number;
    succeeded: number;
    failed: number;
    skippedChanged: number;
    uncertain: number;
    bytesRecovered: number;
  };
  batchSize: number;
  concurrency: number;
  results: JobMessageResult[];
  resultsTruncated: boolean;
  error: string | null;
  warnings: string[];
}

export type ActivityKind = "diagnostic" | "cleanup";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  at: string;
  title: string;
  summary: string;
  status: "success" | "partial" | "failed" | "cancelled";
}

export interface ProviderConnectionStatus {
  provider: ProviderId;
  displayName: string;
  configured: boolean;
  connected: boolean;
  mode: AuthMode | null;
  connectedAt: string | null;
  account: string | null;
  capabilities: ProviderCapabilities;
  setupHint: string;
}

export interface AppStatus {
  name: string;
  version: string;
  baseUrl: string;
  csrfToken: string;
  providers: ProviderConnectionStatus[];
  activity: ActivityItem[];
  privacy: {
    tokenStorage: string;
    telemetry: boolean;
    persistence: string;
  };
}

export interface RoadmapItem {
  text: string;
  status: "complete" | "in-progress" | "planned" | "blocked";
}

export interface RoadmapSection {
  title: string;
  items: RoadmapItem[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
