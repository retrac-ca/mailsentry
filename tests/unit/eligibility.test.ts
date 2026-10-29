import { describe, expect, it } from "vitest";
import { evaluateEligibility, parseFrom, senderIsAllowlisted } from "../../src/core/eligibility.js";
import { syntheticMessage } from "../../src/providers/synthetic.js";
import type { CleanupFilters } from "../../src/shared/types.js";
import { BASE_FILTERS, NOW } from "../helpers/fixtures.js";

function filters(overrides: Partial<CleanupFilters> = {}): CleanupFilters {
  return { ...BASE_FILTERS, ...overrides };
}

const OLD = new Date(NOW - 500 * 86_400_000).toISOString();

function message(overrides: Parameters<typeof syntheticMessage>[1] = {}) {
  return syntheticMessage("m1", { receivedAt: OLD, ...overrides });
}

describe("sender parsing", () => {
  it("extracts addresses from display-name headers", () => {
    expect(parseFrom('"Example, Inc." <News@Example.com>')).toEqual({
      address: "news@example.com",
      domain: "example.com",
    });
    expect(parseFrom("plain@example.org")).toEqual({ address: "plain@example.org", domain: "example.org" });
    expect(parseFrom(null)).toEqual({ address: null, domain: null });
  });

  it("matches allowlist entries by exact address or domain including subdomains", () => {
    const list = filters({ senderAllowlist: ["boss@example.com", "bank.example"] });
    expect(senderIsAllowlisted("Boss <boss@example.com>", list)).toBe(true);
    expect(senderIsAllowlisted("alerts@mail.bank.example", list)).toBe(true);
    expect(senderIsAllowlisted("boss@other.example", list)).toBe(false);
  });
});

describe("eligibility safety rules", () => {
  it("marks an old, read, unprotected message eligible", () => {
    const result = evaluateEligibility(message(), filters(), NOW);
    expect(result.eligible).toBe(true);
    expect(result.uncertain).toBe(false);
  });

  it("never treats drafts as eligible", () => {
    expect(evaluateEligibility(message({ isDraft: true }), filters(), NOW).eligible).toBe(false);
  });

  it.each([
    ["isStarred", "Starred"],
    ["isImportant", "important"],
  ] as const)("protects %s by default", (field, label) => {
    const result = evaluateEligibility(message({ [field]: true }), filters(), NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toContain(label);
  });

  it("protects unread messages by default", () => {
    const result = evaluateEligibility(message({ isRead: false }), filters(), NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/Unread/);
  });

  it("allows protected messages only with explicit opt-in", () => {
    const result = evaluateEligibility(
      message({ isStarred: true, isRead: false, isImportant: true }),
      filters({ includeStarred: true, includeUnread: true, includeImportant: true }),
      NOW,
    );
    expect(result.eligible).toBe(true);
  });

  it("honours allowlists over every other filter", () => {
    const result = evaluateEligibility(
      message({ from: "ceo@example.com" }),
      filters({ senderAllowlist: ["example.com"], includeStarred: true }),
      NOW,
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/allowlist/);
  });

  it("restricts eligibility to targeted senders when configured", () => {
    const filter = filters({ senderTargets: ["news.example"] });
    expect(evaluateEligibility(message({ from: "a@news.example" }), filter, NOW).eligible).toBe(true);
    expect(evaluateEligibility(message({ from: "a@other.example" }), filter, NOW).eligible).toBe(false);
  });

  it("enforces minimum age", () => {
    const young = new Date(NOW - 10 * 86_400_000).toISOString();
    expect(evaluateEligibility(message({ receivedAt: young }), filters(), NOW).eligible).toBe(false);
    expect(
      evaluateEligibility(message({ receivedAt: young }), filters({ minAgeDays: 5 }), NOW).eligible,
    ).toBe(true);
  });

  it("treats an invalid date as uncertain, not eligible", () => {
    const result = evaluateEligibility(message({ receivedAt: "not-a-date" }), filters(), NOW);
    expect(result.eligible).toBe(false);
    expect(result.uncertain).toBe(true);
  });

  it("never makes unknown sizes eligible for a size filter", () => {
    const result = evaluateEligibility(message({ sizeBytes: null }), filters({ minSizeBytes: 1 }), NOW);
    expect(result.eligible).toBe(false);
    expect(result.uncertain).toBe(true);
  });

  it("handles attachment-size filters conservatively", () => {
    const filter = filters({ largeAttachmentBytes: 1_000_000 });
    expect(evaluateEligibility(message({ hasAttachments: false }), filter, NOW).eligible).toBe(false);
    expect(
      evaluateEligibility(message({ hasAttachments: true, attachmentBytes: null }), filter, NOW).uncertain,
    ).toBe(true);
    expect(
      evaluateEligibility(message({ hasAttachments: true, attachmentBytes: 2_000_000 }), filter, NOW)
        .eligible,
    ).toBe(true);
    expect(
      evaluateEligibility(message({ hasAttachments: true, attachmentBytes: 500_000 }), filter, NOW).eligible,
    ).toBe(false);
  });

  it("excludes uncertain bulk classifications from eligibility", () => {
    const possible = evaluateEligibility(
      message({ bulk: { level: "possible", evidence: "sender heuristic" } }),
      filters({ bulkOnly: true }),
      NOW,
    );
    expect(possible.eligible).toBe(false);
    expect(possible.uncertain).toBe(true);
    const likely = evaluateEligibility(
      message({ bulk: { level: "likely", evidence: "List-Id" } }),
      filters({ bulkOnly: true }),
      NOW,
    );
    expect(likely.eligible).toBe(true);
  });

  it("bypasses criteria for Empty Trash but keeps protections", () => {
    const youngStarred = message({
      receivedAt: new Date(NOW - 86_400_000).toISOString(),
      isStarred: true,
    });
    expect(evaluateEligibility(youngStarred, filters(), NOW, { applyCriteria: false }).eligible).toBe(false);
    const protectedOff = evaluateEligibility(youngStarred, filters({ includeStarred: true }), NOW, {
      applyCriteria: false,
    });
    expect(protectedOff.eligible).toBe(true);
  });
});
