import { describe, expect, it } from "vitest";
import { runDiagnostics } from "../../src/diagnostics/index.js";
import { FakeDnsResolver, NOW } from "../helpers/fixtures.js";

const DOMAIN = "example.com";

function configuredResolver(): FakeDnsResolver {
  const dns = new FakeDnsResolver();
  dns.setMx(DOMAIN, [
    { exchange: "mx2.example.net", priority: 20 },
    { exchange: "mx1.example.net", priority: 10 },
  ]);
  dns.setTxt(DOMAIN, ["v=spf1 include:_spf.example.net -all"]);
  dns.setTxt(`_dmarc.${DOMAIN}`, ["v=DMARC1; p=reject; rua=mailto:dmarc@example.com"]);
  dns.setTxt(`selector1._domainkey.${DOMAIN}`, ["v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"]);
  return dns;
}

describe("DNS diagnostics orchestration", () => {
  it("reports a fully configured domain without making recursive or extra queries", async () => {
    const dns = configuredResolver();
    const report = await runDiagnostics({
      domain: "EXAMPLE.com",
      dkimSelector: "selector1",
      resolver: dns,
      now: NOW,
    });
    expect(report.domain).toBe("example.com");
    expect(report.checkedAt).toBe(new Date(NOW).toISOString());
    expect(report.status).toBe("ok");
    expect(report.dkimSelector).toBe("selector1");
    expect(report.findings.some((finding) => finding.id === "mx-present")).toBe(true);
    expect(report.findings.some((finding) => finding.id === "dmarc-policy-reject")).toBe(true);
    expect(report.findings.some((finding) => finding.id === "dkim-present")).toBe(true);
    expect(dns.calls).toEqual([
      { type: "MX", name: DOMAIN },
      { type: "TXT", name: DOMAIN },
      { type: "TXT", name: `_dmarc.${DOMAIN}` },
      { type: "TXT", name: `selector1._domainkey.${DOMAIN}` },
    ]);
  });

  it("distinguishes missing records from failed lookups", async () => {
    const dns = new FakeDnsResolver();
    dns.setMxFailure(DOMAIN, {
      ok: false,
      code: "SERVFAIL",
      message: "The DNS server returned SERVFAIL.",
      transient: true,
    });
    dns.setTxtFailure(DOMAIN, {
      ok: false,
      code: "TIMEOUT",
      message: "The DNS query timed out.",
      transient: true,
    });
    dns.setTxtFailure(`_dmarc.${DOMAIN}`, {
      ok: false,
      code: "NXDOMAIN",
      message: "The name does not exist (NXDOMAIN).",
      transient: false,
    });
    const report = await runDiagnostics({ domain: DOMAIN, resolver: dns, now: NOW });
    expect(report.status).toBe("failed");
    expect(report.findings.find((finding) => finding.check === "mx")?.confidence).toBe("inconclusive");
    expect(report.findings.find((finding) => finding.check === "spf")?.observed).toMatch(/timed out/i);
    expect(report.findings.find((finding) => finding.check === "dmarc")?.observed).toMatch(/does not exist/i);
    expect(report.findings.find((finding) => finding.check === "mx")?.severity).toBe("warning");
  });

  it("marks a typical domain with no mail records clearly", async () => {
    const dns = new FakeDnsResolver();
    dns.setTxt("_dmarc.example.org", ["v=DMARC1; p=none; rua=mailto:reports@example.org"]);
    const report = await runDiagnostics({ domain: "example.org", resolver: dns, now: NOW });
    expect(report.status).toBe("ok");
    expect(report.findings.some((finding) => finding.id === "mx-missing")).toBe(true);
    expect(report.findings.some((finding) => finding.id === "spf-missing")).toBe(true);
    expect(report.findings.some((finding) => finding.id === "dmarc-policy-none")).toBe(true);
    expect(report.findings.find((finding) => finding.id === "mx-missing")?.severity).toBe("critical");
  });

  it("does not query DKIM without a selector and explains why", async () => {
    const dns = configuredResolver();
    const report = await runDiagnostics({ domain: DOMAIN, resolver: dns, now: NOW });
    expect(report.findings.some((finding) => finding.id === "dkim-no-selector")).toBe(true);
    expect(report.findings.find((finding) => finding.id === "dkim-no-selector")?.confidence).toBe(
      "inconclusive",
    );
    expect(dns.calls.some((call) => call.type === "TXT" && call.name.includes("_domainkey"))).toBe(false);
  });

  it("reports a revoked DKIM key", async () => {
    const dns = configuredResolver();
    dns.setTxt(`selector1._domainkey.${DOMAIN}`, ["v=DKIM1; k=rsa; p="]);
    const report = await runDiagnostics({
      domain: DOMAIN,
      dkimSelector: "selector1",
      resolver: dns,
      now: NOW,
    });
    expect(report.findings.find((finding) => finding.id === "dkim-invalid")?.severity).toBe("warning");
  });

  it("marks multiple SPF records as critical", async () => {
    const dns = configuredResolver();
    dns.setTxt(DOMAIN, ["v=spf1 -all", "v=spf1 ~all"]);
    const report = await runDiagnostics({ domain: DOMAIN, resolver: dns, now: NOW });
    expect(report.findings.find((finding) => finding.id === "spf-multiple")?.severity).toBe("critical");
  });

  it("reports null MX as informational rather than a failure", async () => {
    const dns = configuredResolver();
    dns.setMx(DOMAIN, [{ exchange: ".", priority: 0 }]);
    const report = await runDiagnostics({ domain: DOMAIN, resolver: dns, now: NOW });
    expect(report.findings.find((finding) => finding.id === "mx-null")?.severity).toBe("info");
    expect(report.findings.some((finding) => finding.id === "mx-missing")).toBe(false);
  });

  it("rejects invalid domains before any DNS call", async () => {
    const dns = new FakeDnsResolver();
    await expect(runDiagnostics({ domain: "127.0.0.1", resolver: dns })).rejects.toThrow();
    expect(dns.calls).toHaveLength(0);
  });
});
