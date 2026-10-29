/** Safe helpers for MIME-encoded header display values. */

const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

function decodeWord(charset: string, encoding: string, payload: string): string {
  try {
    let bytes: Buffer;
    if (encoding.toUpperCase() === "B") {
      bytes = Buffer.from(payload, "base64");
    } else {
      const qp = payload
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      bytes = Buffer.from(qp, "binary");
    }
    const normalized = charset.toLowerCase().replace(/^utf8$/, "utf-8");
    if (normalized === "utf-8" || normalized === "us-ascii" || normalized === "ascii") {
      return bytes.toString("utf8");
    }
    // Only a small allowlist of legacy encodings; unsupported values stay raw.
    if (normalized === "iso-8859-1" || normalized === "latin1") return bytes.toString("latin1");
    return bytes.toString("utf8");
  } catch {
    return payload;
  }
}

export function decodeHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const decoded = value.replace(ENCODED_WORD, (_match, charset: string, encoding: string, payload: string) =>
    decodeWord(charset, encoding, payload),
  );
  return decoded.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
}

export function truncate(value: string | null, max = 160): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
