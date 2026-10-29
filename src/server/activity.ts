import type { ActivityItem, CleanupJob, DiagnosticReport } from "../shared/types.js";
import type { SessionData } from "./session.js";

function diagnosticStatus(report: DiagnosticReport): ActivityItem["status"] {
  if (report.status === "failed") return "failed";
  if (report.status === "partial") return "partial";
  if (report.findings.some((finding) => finding.severity === "critical")) return "partial";
  return "success";
}

function jobStatus(job: CleanupJob): ActivityItem["status"] {
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "failed") return "failed";
  if (job.status === "running" || job.status === "queued") return "partial";
  if (job.progress.failed > 0 || job.progress.uncertain > 0) return "partial";
  return "success";
}

export function buildActivity(session: SessionData, limit = 20): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const report of session.diagnostics) {
    const counts = { critical: 0, warning: 0, pass: 0, info: 0 };
    for (const finding of report.findings) counts[finding.severity] += 1;
    items.push({
      id: `diagnostic:${report.domain}:${report.checkedAt}`,
      kind: "diagnostic",
      at: report.checkedAt,
      title: `Email health · ${report.domain}`,
      summary: `${counts.critical} critical, ${counts.warning} warning, ${counts.pass} passing, ${counts.info} informational`,
      status: diagnosticStatus(report),
    });
  }

  for (const job of session.jobs.values()) {
    const actionLabel =
      job.action === "permanentDelete"
        ? "permanent delete"
        : job.action === "emptyTrash"
          ? "empty trash"
          : job.action;
    const modeLabel = job.mode === "dry-run" ? "Dry run" : "Cleanup";
    items.push({
      id: job.id,
      kind: "cleanup",
      at: job.finishedAt ?? job.createdAt,
      title: `${modeLabel} · ${actionLabel} · ${job.provider === "gmail" ? "Gmail" : "Microsoft"}`,
      summary:
        job.status === "running"
          ? `${job.progress.processed} of ${job.total} processed`
          : `${job.progress.succeeded} succeeded, ${job.progress.failed} failed, ${job.progress.skippedChanged} skipped, ${job.progress.uncertain} uncertain`,
      status: jobStatus(job),
    });
  }

  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}
