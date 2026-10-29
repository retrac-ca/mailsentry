/** DMARC record discovery and basic tag validation (RFC 7489). */

export type DmarcPolicy = "none" | "quarantine" | "reject";

export interface DmarcAnalysis {
  present: boolean;
  records: string[];
  record: string | null;
  tags: Record<string, string>;
  policy: DmarcPolicy | null;
  subdomainPolicy: DmarcPolicy | null;
  percentage: number | null;
  aggregateReports: string[];
  forensicReports: string[];
  errors: string[];
  notes: string[];
}

function isDmarc(value: string): boolean {
  return /(?:^|;)\s*v=DMARC1\s*(?:;|$)/i.test(value.trim());
}

function parsePolicy(value: string | undefined): DmarcPolicy | null {
  const normalized = value?.toLowerCase();
  return normalized === "none" || normalized === "quarantine" || normalized === "reject" ? normalized : null;
}

function parseUris(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function analyzeDmarc(txtRecords: string[]): DmarcAnalysis {
  const records = txtRecords.map((value) => value.trim()).filter(isDmarc);
  if (records.length === 0) {
    return {
      present: false,
      records,
      record: null,
      tags: {},
      policy: null,
      subdomainPolicy: null,
      percentage: null,
      aggregateReports: [],
      forensicReports: [],
      errors: [],
      notes: [],
    };
  }

  const errors: string[] = [];
  const notes: string[] = [];
  const record = records[0] ?? null;
  if (records.length > 1) {
    errors.push(
      `Multiple DMARC records exist (${records.length}). Receivers cannot choose reliably; publish exactly one.`,
    );
  }
  if (!record) {
    return {
      present: false,
      records,
      record: null,
      tags: {},
      policy: null,
      subdomainPolicy: null,
      percentage: null,
      aggregateReports: [],
      forensicReports: [],
      errors,
      notes,
    };
  }

  const tags: Record<string, string> = {};
  const parts = record
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index <= 0) {
      errors.push(`Malformed tag segment: ${part.slice(0, 60)}`);
      continue;
    }
    const key = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (key in tags) errors.push(`Duplicate tag: ${key}`);
    tags[key] = value;
  }

  if (!("v" in tags)) {
    errors.push("The mandatory v tag is missing.");
  } else if (!/^DMARC1$/i.test(tags["v"] ?? "")) {
    errors.push("The v tag must be DMARC1.");
  } else if (parts[0]?.split("=")[0]?.trim().toLowerCase() !== "v") {
    notes.push("The v tag should be the first tag in the record.");
  }

  const policy = parsePolicy(tags["p"]);
  if (!("p" in tags)) errors.push("The mandatory policy tag (p) is missing.");
  else if (!policy) errors.push(`Invalid policy value: ${(tags["p"] ?? "").slice(0, 30) || "(empty)"}`);

  const sp = parsePolicy(tags["sp"]);
  if ("sp" in tags && !sp) errors.push(`Invalid subdomain policy value: ${(tags["sp"] ?? "").slice(0, 30)}`);

  let percentage: number | null = null;
  if ("pct" in tags) {
    const parsed = Number(tags["pct"]);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      errors.push("pct must be an integer from 0 to 100.");
    } else {
      percentage = parsed;
      if (parsed === 0) notes.push("pct=0 means the policy is effectively monitoring only.");
      else if (parsed < 100)
        notes.push(`pct=${parsed}: only that percentage of failing mail is subject to the policy.`);
    }
  }

  const aggregateReports = parseUris(tags["rua"]);
  const forensicReports = parseUris(tags["ruf"]);
  for (const uri of [...aggregateReports, ...forensicReports]) {
    if (!/^(mailto:|https?:)/i.test(uri)) {
      errors.push(`Report URI is not mailto/http(s): ${uri.slice(0, 60)}`);
    }
  }
  if ("rua" in tags && aggregateReports.length === 0) errors.push("rua is present but empty.");
  if ("ruf" in tags && forensicReports.length === 0) errors.push("ruf is present but empty.");

  for (const key of ["adkim", "aspf"]) {
    if (key in tags && !/^[rs]$/i.test(tags[key] ?? "")) {
      errors.push(`${key} must be r (relaxed) or s (strict).`);
    }
  }
  if (!("rua" in tags))
    notes.push("No rua tag: aggregate reporting is not requested, so visibility into failures is limited.");

  return {
    present: true,
    records,
    record,
    tags,
    policy,
    subdomainPolicy: sp,
    percentage,
    aggregateReports,
    forensicReports,
    errors,
    notes,
  };
}
