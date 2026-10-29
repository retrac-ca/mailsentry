export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${formatNumber(count)} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

export function providerName(provider: string): string {
  return provider === "gmail" ? "Gmail" : provider === "microsoft" ? "Microsoft 365 / Outlook" : provider;
}

export function actionName(action: string): string {
  switch (action) {
    case "archive":
      return "Archive";
    case "trash":
      return "Move to Trash";
    case "permanentDelete":
      return "Permanently delete";
    case "emptyTrash":
      return "Empty Trash";
    default:
      return action;
  }
}

export function folderName(folder: string): string {
  switch (folder) {
    case "inbox":
      return "Inbox";
    case "spam":
      return "Spam / Junk";
    case "trash":
      return "Trash / Deleted Items";
    default:
      return "Other";
  }
}

export function severityLabel(severity: string): string {
  switch (severity) {
    case "pass":
      return "Pass";
    case "critical":
      return "Critical";
    case "warning":
      return "Warning";
    default:
      return "Info";
  }
}
