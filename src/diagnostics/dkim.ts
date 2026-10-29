/** DKIM public-key record parsing. This does not verify message signatures. */

export interface DkimAnalysis {
  present: boolean;
  record: string | null;
  revoked: boolean;
  testing: boolean;
  keyType: string | null;
  hasPublicKey: boolean;
  errors: string[];
  notes: string[];
}

export function analyzeDkim(txtRecords: string[]): DkimAnalysis {
  const records = txtRecords
    .map((record) => record.trim())
    .filter((record) => /(?:^|;)\s*v=DKIM1\b/i.test(record) || /(?:^|;)\s*p=/i.test(record));
  if (records.length === 0) {
    return {
      present: false,
      record: null,
      revoked: false,
      testing: false,
      keyType: null,
      hasPublicKey: false,
      errors: [],
      notes: [],
    };
  }
  const errors: string[] = [];
  const notes: string[] = [];
  if (records.length > 1) notes.push("Multiple DKIM records exist at this selector; the first was analyzed.");

  const record = records[0] ?? "";
  const tags: Record<string, string> = {};
  for (const part of record
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const index = part.indexOf("=");
    if (index <= 0) {
      errors.push(`Malformed DKIM tag: ${part.slice(0, 50)}`);
      continue;
    }
    tags[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim();
  }

  if ("v" in tags && !/^DKIM1$/i.test(tags["v"] ?? "")) {
    errors.push(`Unsupported DKIM version: ${(tags["v"] ?? "").slice(0, 20)}`);
  }
  const keyType = tags["k"]?.toLowerCase() ?? "rsa";
  if (!["rsa", "ed25519"].includes(keyType)) {
    errors.push(`Unsupported key type: ${keyType.slice(0, 20)}`);
  }
  const publicKey = tags["p"];
  const hasPublicKey = typeof publicKey === "string" && publicKey.length > 0;
  const revoked = publicKey === "";
  if (revoked) errors.push("The public key is empty (p=), which revokes the selector.");
  else if (!("p" in tags)) errors.push("The required p (public key) tag is missing.");
  const testing = tags["t"]?.split(":").includes("y") === true;
  if (testing) notes.push("t=y marks the domain as testing; receivers may treat signatures with suspicion.");
  if ("s" in tags && !tags["s"]?.split(":").includes("*") && !tags["s"]?.split(":").includes("email")) {
    notes.push("The s= service tag does not list email; this key may not be intended for email.");
  }
  if ("h" in tags && !/sha256/i.test(tags["h"] ?? "")) {
    notes.push("The record does not advertise sha256 in h=; verify with your provider.");
  }

  return { present: true, record, revoked, testing, keyType, hasPublicKey, errors, notes };
}
