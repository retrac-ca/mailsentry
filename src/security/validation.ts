import { domainToASCII } from "node:url";
import type { AuthMode, CleanupAction, CleanupFilters, FolderKind, ProviderId } from "../shared/types.js";
import { AppError } from "../core/errors.js";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".corp",
  ".private",
];

export const MAX_DOMAIN_LENGTH = 253;
export const MAX_SELECTOR_LENGTH = 63;

/**
 * Normalize and validate a public domain name used for DNS diagnostics.
 * This intentionally rejects single-label names, IP literals, and internal
 * suffixes so the diagnostics feature cannot be used as an internal scanner.
 */
export function normalizeDomain(input: unknown): string {
  if (typeof input !== "string") {
    throw new AppError("VALIDATION", "Domain must be a string.", 400);
  }
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed.length === 0) throw new AppError("VALIDATION", "Domain is required.", 400);
  if (trimmed.length > MAX_DOMAIN_LENGTH) {
    throw new AppError("VALIDATION", "Domain is too long.", 400);
  }
  if (/[\s/@:#?\\]/.test(trimmed)) {
    throw new AppError("VALIDATION", "Domain contains invalid characters.", 400);
  }
  if (IPV4.test(trimmed) || trimmed.includes(":") || /^\[.*\]$/.test(trimmed)) {
    throw new AppError("VALIDATION", "IP addresses are not accepted; enter a domain name.", 400);
  }
  const ascii = domainToASCII(trimmed);
  if (!ascii) throw new AppError("VALIDATION", "Domain is not valid.", 400);
  if (!ascii.includes(".")) {
    throw new AppError("VALIDATION", "Enter a fully qualified domain name, for example example.com.", 400);
  }
  const labels = ascii.split(".");
  if (labels.length < 2 || labels.some((label) => !LABEL.test(label))) {
    throw new AppError("VALIDATION", "Domain is not valid.", 400);
  }
  const tld = labels.at(-1) ?? "";
  if (tld.length < 2 || /^\d+$/.test(tld)) {
    throw new AppError("VALIDATION", "Domain is not valid.", 400);
  }
  if (ascii === "localhost" || BLOCKED_SUFFIXES.some((suffix) => ascii.endsWith(suffix))) {
    throw new AppError(
      "VALIDATION",
      "Internal, local, and reserved domains are not accepted by this tool.",
      400,
    );
  }
  return ascii;
}

/** DKIM selectors are single DNS labels, not full domains. */
export function normalizeSelector(input: unknown): string {
  if (input === undefined || input === null || input === "") return "";
  if (typeof input !== "string") throw new AppError("VALIDATION", "Selector must be a string.", 400);
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed.length === 0) return "";
  if (trimmed.length > MAX_SELECTOR_LENGTH) {
    throw new AppError("VALIDATION", "DKIM selector is too long.", 400);
  }
  if (!LABEL.test(trimmed)) {
    throw new AppError("VALIDATION", "DKIM selector is not a valid DNS label.", 400);
  }
  return trimmed;
}

const FOLDERS: readonly FolderKind[] = ["inbox", "spam", "trash"];
const ACTIONS: readonly CleanupAction[] = ["archive", "trash", "permanentDelete", "emptyTrash"];

export function parseFolders(input: unknown): FolderKind[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AppError("VALIDATION", "Select at least one folder.", 400);
  }
  const unique = new Set<FolderKind>();
  for (const value of input) {
    if (typeof value !== "string" || !FOLDERS.includes(value as FolderKind)) {
      throw new AppError("VALIDATION", "Unknown folder selection.", 400);
    }
    unique.add(value as FolderKind);
  }
  return FOLDERS.filter((folder) => unique.has(folder));
}

export function parseAction(input: unknown): CleanupAction {
  if (typeof input !== "string" || !ACTIONS.includes(input as CleanupAction)) {
    throw new AppError("VALIDATION", "Unknown cleanup action.", 400);
  }
  return input as CleanupAction;
}

function senderValue(input: unknown): string {
  if (typeof input !== "string") throw new AppError("VALIDATION", "Sender filters must be text.", 400);
  const value = input.trim().toLowerCase();
  if (value.length === 0 || value.length > 254) {
    throw new AppError("VALIDATION", "Sender filter is empty or too long.", 400);
  }
  if (!/^[a-z0-9@._+-]+$/.test(value)) {
    throw new AppError("VALIDATION", "Sender filters may contain addresses or domains only.", 400);
  }
  return value;
}

export function parseFilters(input: unknown): CleanupFilters {
  if (typeof input !== "object" || input === null) {
    throw new AppError("VALIDATION", "Filters are required.", 400);
  }
  const raw = input as Record<string, unknown>;
  const minAgeDays = Number(raw["minAgeDays"] ?? 0);
  if (!Number.isFinite(minAgeDays) || minAgeDays < 0 || minAgeDays > 36_500) {
    throw new AppError("VALIDATION", "Minimum age must be between 0 and 36500 days.", 400);
  }
  const size = (value: unknown, field: string): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new AppError("VALIDATION", `${field} must be a non-negative whole number of bytes.`, 400);
    }
    return n;
  };
  const list = (value: unknown): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new AppError("VALIDATION", "Sender filters must be a list.", 400);
    if (value.length > 100) throw new AppError("VALIDATION", "Too many sender filters (max 100).", 400);
    return [...new Set(value.map(senderValue))];
  };
  const bool = (value: unknown): boolean => value === true;

  return {
    minAgeDays,
    minSizeBytes: size(raw["minSizeBytes"], "Minimum size"),
    largeAttachmentBytes: size(raw["largeAttachmentBytes"], "Attachment size"),
    bulkOnly: bool(raw["bulkOnly"]),
    senderAllowlist: list(raw["senderAllowlist"]),
    senderTargets: list(raw["senderTargets"]),
    includeStarred: bool(raw["includeStarred"]),
    includeUnread: bool(raw["includeUnread"]),
    includeImportant: bool(raw["includeImportant"]),
  };
}

export function parseConfirmation(input: unknown): string {
  if (input !== undefined && typeof input !== "string") {
    throw new AppError("VALIDATION", "Confirmation must be a string.", 400);
  }
  return typeof input === "string" ? input : "";
}

export function parseBoundedInt(input: unknown, fallback: number, min: number, max: number): number {
  if (input === undefined || input === null || input === "") return fallback;
  const n = Number(input);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new AppError("VALIDATION", `Value must be an integer between ${min} and ${max}.`, 400);
  }
  return n;
}

export function parseProvider(input: unknown): ProviderId {
  if (input !== "gmail" && input !== "microsoft") {
    throw new AppError("VALIDATION", "Unknown provider.", 400);
  }
  return input;
}

export function parseAuthMode(input: unknown): AuthMode {
  if (input === undefined || input === null || input === "") return "readonly";
  if (input !== "readonly" && input !== "cleanup") {
    throw new AppError("VALIDATION", "Authorization mode must be readonly or cleanup.", 400);
  }
  return input;
}
