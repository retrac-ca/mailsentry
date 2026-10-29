import { describe, expect, it } from "vitest";
import { analyzeSpf } from "../../src/diagnostics/spf.js";
import { analyzeDmarc } from "../../src/diagnostics/dmarc.js";
import { analyzeDkim } from "../../src/diagnostics/dkim.js";

describe("SPF analysis", () => {
  it("returns not present when no SPF record exists", () => {
    const result = analyzeSpf(["v=google-site-verification=abc"]);
    expect(result.present).toBe(false);
    expect(result.record).toBeNull();
  });

  it("parses a valid record and counts lookup mechanisms", () => {
    const result = analyzeSpf([
      "v=spf1 include:_spf.example.com include:mailer.example.net ip4:192.0.2.0/24 -all",
    ]);
    expect(result.present).toBe(true);
    expect(result.lookups).toBe(2);
    expect(result.allQualifier).toBe("-");
    expect(result.errors).toEqual([]);
  });

  it("detects multiple SPF records", () => {
    const result = analyzeSpf(["v=spf1 -all", "v=spf1 ~all"]);
    expect(result.records).toHaveLength(2);
    expect(result.errors.join(" ")).toMatch(/Multiple SPF records/);
  });

  it("flags +all as dangerous", () => {
    const result = analyzeSpf(["v=spf1 include:example.net +all"]);
    expect(result.allQualifier).toBe("+");
  });

  it("flags malformed mechanisms", () => {
    const result = analyzeSpf(["v=spf1 mystery:example.com -all"]);
    expect(result.errors.join(" ")).toMatch(/Unknown SPF mechanism/);
  });

  it("flags more than ten lookup terms", () => {
    const includes = Array.from({ length: 11 }, (_v, i) => `include:s${i}.example.com`).join(" ");
    const result = analyzeSpf([`v=spf1 ${includes} -all`]);
    expect(result.lookups).toBe(11);
    expect(result.errors.join(" ")).toMatch(/DNS-lookup limit/);
  });

  it("notes records near but under the lookup limit", () => {
    const includes = Array.from({ length: 9 }, (_v, i) => `include:s${i}.example.com`).join(" ");
    const result = analyzeSpf([`v=spf1 ${includes} -all`]);
    expect(result.errors).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/close to the 10/);
  });

  it("notes missing all and macros without evaluating them", () => {
    const result = analyzeSpf(["v=spf1 include:%{d}.example.com"]);
    expect(result.allQualifier).toBeNull();
    expect(result.notes.join(" ")).toMatch(/No all mechanism/);
    expect(result.notes.join(" ")).toMatch(/Macros/);
  });

  it("rejects invalid ip4 values", () => {
    const result = analyzeSpf(["v=spf1 ip4:999.1.1.1 -all"]);
    expect(result.errors.join(" ")).toMatch(/Invalid ip4/);
  });
});

describe("DMARC analysis", () => {
  it("returns not present when no record exists", () => {
    expect(analyzeDmarc(["v=spf1 -all"]).present).toBe(false);
  });

  it("parses a monitoring policy with reporting", () => {
    const result = analyzeDmarc(["v=DMARC1; p=none; rua=mailto:dmarc@example.com; pct=50"]);
    expect(result.present).toBe(true);
    expect(result.policy).toBe("none");
    expect(result.percentage).toBe(50);
    expect(result.aggregateReports).toEqual(["mailto:dmarc@example.com"]);
    expect(result.errors).toEqual([]);
  });

  it("parses quarantine and reject policies", () => {
    expect(analyzeDmarc(["v=DMARC1; p=quarantine; sp=reject"]).policy).toBe("quarantine");
    expect(analyzeDmarc(["v=DMARC1; p=reject"]).policy).toBe("reject");
  });

  it("flags multiple records", () => {
    const result = analyzeDmarc(["v=DMARC1; p=none", "v=DMARC1; p=reject"]);
    expect(result.errors.join(" ")).toMatch(/Multiple DMARC/);
  });

  it("flags invalid policy, pct, and report URIs", () => {
    const result = analyzeDmarc(["v=DMARC1; p=block; pct=500; rua=ftp://example.com"]);
    expect(result.errors.join(" ")).toMatch(/Invalid policy/);
    expect(result.errors.join(" ")).toMatch(/pct/);
    expect(result.errors.join(" ")).toMatch(/Report URI/);
  });

  it("flags missing mandatory tags", () => {
    const result = analyzeDmarc(["v=DMARC1; rua=mailto:x@example.com"]);
    expect(result.errors.join(" ")).toMatch(/policy tag/);
  });

  it("notes missing reporting address", () => {
    const result = analyzeDmarc(["v=DMARC1; p=reject"]);
    expect(result.notes.join(" ")).toMatch(/No rua/);
  });

  it("flags v tag not first", () => {
    const result = analyzeDmarc(["p=reject; v=DMARC1"]);
    expect(result.notes.join(" ")).toMatch(/first tag/);
  });
});

describe("DKIM analysis", () => {
  it("parses a valid RSA key", () => {
    const result = analyzeDkim(["v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"]);
    expect(result.present).toBe(true);
    expect(result.hasPublicKey).toBe(true);
    expect(result.keyType).toBe("rsa");
    expect(result.errors).toEqual([]);
  });

  it("detects revoked keys", () => {
    const result = analyzeDkim(["v=DKIM1; k=rsa; p="]);
    expect(result.revoked).toBe(true);
    expect(result.errors.join(" ")).toMatch(/revokes/);
  });

  it("notes testing mode", () => {
    const result = analyzeDkim(["v=DKIM1; k=rsa; p=abc; t=y"]);
    expect(result.testing).toBe(true);
  });

  it("returns absent for unrelated TXT records", () => {
    expect(analyzeDkim(["not a dkim record"]).present).toBe(false);
  });
});
