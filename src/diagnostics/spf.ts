/**
 * Conservative SPF syntax analysis. This is not a full RFC 7208 evaluator:
 * it counts local DNS-lookup mechanisms and flags structurally invalid records.
 * It never performs recursive DNS queries.
 */

export interface SpfAnalysis {
  present: boolean;
  records: string[];
  record: string | null;
  lookups: number;
  allQualifier: "+" | "-" | "~" | "?" | null;
  redirect: string | null;
  errors: string[];
  notes: string[];
}

const LOOKUP_MECHANISMS = new Set(["include", "a", "mx", "ptr", "exists", "redirect"]);
const KNOWN_MECHANISMS = new Set([
  "all",
  "include",
  "a",
  "mx",
  "ptr",
  "ip4",
  "ip6",
  "exists",
  "redirect",
  "exp",
]);

const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/;
const IPV6_PATTERN = /^[0-9a-f:]+(?:\/\d{1,3})?$/i;

function validIpv4(value: string): boolean {
  if (!IPV4_PATTERN.test(value)) return false;
  const [address, prefix] = value.split("/");
  const octets = (address ?? "").split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  if (prefix !== undefined) {
    const parsed = Number(prefix);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 32) return false;
  }
  return true;
}

function isSpf(value: string): boolean {
  return /^v=spf1(?:\s|$)/i.test(value.trim());
}

export function analyzeSpf(txtRecords: string[]): SpfAnalysis {
  const records = txtRecords.map((value) => value.trim()).filter(isSpf);
  if (records.length === 0) {
    return {
      present: false,
      records,
      record: null,
      lookups: 0,
      allQualifier: null,
      redirect: null,
      errors: [],
      notes: [],
    };
  }

  const record = records[0] ?? null;
  const errors: string[] = [];
  const notes: string[] = [];
  if (records.length > 1) {
    errors.push(
      `Multiple SPF records exist (${records.length}). RFC 7208 requires exactly one; receivers may return a permanent error.`,
    );
  }
  if (!record) {
    return {
      present: false,
      records,
      record: null,
      lookups: 0,
      allQualifier: null,
      redirect: null,
      errors,
      notes,
    };
  }

  const tokens = record.split(/\s+/).filter(Boolean);
  if (!/^v=spf1$/i.test(tokens[0] ?? "")) {
    errors.push("The record does not begin with v=spf1.");
  }

  let lookups = 0;
  let allQualifier: SpfAnalysis["allQualifier"] = null;
  let redirect: string | null = null;
  const seen = new Set<string>();

  for (const token of tokens.slice(1)) {
    if (token.includes("%{")) {
      notes.push("Macros are present; this analysis cannot expand them.");
    }
    const match = /^([+\-~?]?)([a-z0-9]+)(?:[:=](.*))?$/i.exec(token);
    if (!match) {
      errors.push(`Unrecognized SPF term: ${token.slice(0, 80)}`);
      continue;
    }
    const qualifier = match[1] || "+";
    const mechanism = (match[2] ?? "").toLowerCase();
    const value = match[3] ?? "";

    if (!KNOWN_MECHANISMS.has(mechanism)) {
      errors.push(`Unknown SPF mechanism: ${mechanism.slice(0, 40)}`);
      continue;
    }
    if (LOOKUP_MECHANISMS.has(mechanism)) lookups += 1;

    if (mechanism === "all") {
      if (allQualifier !== null) notes.push("Multiple all mechanisms are present; the first one applies.");
      if (allQualifier === null) {
        allQualifier =
          qualifier === "+" || qualifier === "-" || qualifier === "~" || qualifier === "?" ? qualifier : null;
      }
    }
    if (mechanism === "redirect") {
      if (value) redirect = value;
      else errors.push("redirect has no target domain.");
      if (allQualifier !== null) {
        notes.push(
          "A redirect term appears with an all mechanism; all takes precedence and redirect is ignored by receivers.",
        );
      }
    }
    if (mechanism === "include" && !value) errors.push("include has no target domain.");
    if (mechanism === "exists" && !value) errors.push("exists has no target domain.");
    if (mechanism === "a" || mechanism === "mx" || mechanism === "ptr" || mechanism === "exp") {
      if (value && !value.includes("%{") && !DOMAIN_PATTERN.test(value.split("/")[0] ?? "")) {
        errors.push(`${mechanism} references an invalid domain.`);
      }
    }
    if (mechanism === "ip4" && !validIpv4(value)) errors.push("Invalid ip4 address or CIDR.");
    if (mechanism === "ip6" && !(IPV6_PATTERN.test(value) || value.includes("%{")))
      errors.push("Invalid ip6 address or CIDR.");

    if (seen.has(mechanism)) notes.push(`Duplicate ${mechanism} mechanism.`);
    seen.add(mechanism);
  }

  if (lookups > 10) {
    errors.push(
      `The record requires at least ${lookups} DNS-lookup terms, exceeding the DNS-lookup limit (10 across the whole evaluation). Nested includes can add more.`,
    );
  } else if (lookups > 8) {
    notes.push(`The record is close to the 10 DNS-lookup limit (${lookups} top-level terms).`);
  }
  if (allQualifier === null && !redirect) {
    notes.push("No all mechanism or redirect; receivers use a neutral default.");
  }

  return { present: true, records, record, lookups, allQualifier, redirect, errors, notes };
}
