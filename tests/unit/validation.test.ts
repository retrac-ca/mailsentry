import { describe, expect, it } from "vitest";
import {
  normalizeDomain,
  normalizeSelector,
  parseAuthMode,
  parseFilters,
  parseFolders,
  parseProvider,
} from "../../src/security/validation.js";
import { AppError } from "../../src/core/errors.js";
import { assertActionFolders } from "../../src/core/scan.js";
import { BASE_FILTERS } from "../helpers/fixtures.js";

describe("domain validation", () => {
  it("normalizes case, trailing dots, and unicode domains", () => {
    expect(normalizeDomain("Example.COM.")).toBe("example.com");
    expect(normalizeDomain("bücher.example")).toBe("xn--bcher-kva.example");
  });

  it.each([
    "",
    "localhost",
    "mail.localhost",
    "printer.local",
    "server.internal",
    "127.0.0.1",
    "::1",
    "[::1]",
    "http://example.com",
    "user@example.com",
    "example.com/path",
    "example",
    "-bad.example",
    "bad-.example",
    "example.123",
    "a".repeat(300) + ".com",
  ])("rejects invalid or internal input %s", (input) => {
    expect(() => normalizeDomain(input)).toThrow(AppError);
  });

  it("rejects non-string input", () => {
    expect(() => normalizeDomain(42)).toThrow(AppError);
    expect(() => normalizeDomain(null)).toThrow(AppError);
  });
});

describe("DKIM selector validation", () => {
  it("accepts a single DNS label", () => {
    expect(normalizeSelector("20230601")).toBe("20230601");
    expect(normalizeSelector("google")).toBe("google");
    expect(normalizeSelector("")).toBe("");
  });

  it.each(["selector.example.com", "bad selector", "_bad", "-bad", "bad-"])("rejects %s", (input) => {
    expect(() => normalizeSelector(input)).toThrow(AppError);
  });
});

describe("folder/action/provider parsing", () => {
  it("deduplicates and orders folders without implicit selection", () => {
    expect(parseFolders(["trash", "inbox", "trash"])).toEqual(["inbox", "trash"]);
    expect(() => parseFolders([])).toThrow(AppError);
    expect(() => parseFolders(["archive"])).toThrow(AppError);
    expect(() => parseFolders("inbox")).toThrow(AppError);
  });

  it("parses provider and auth mode strictly", () => {
    expect(parseProvider("gmail")).toBe("gmail");
    expect(parseProvider("microsoft")).toBe("microsoft");
    expect(() => parseProvider("yahoo")).toThrow(AppError);
    expect(parseAuthMode(undefined)).toBe("readonly");
    expect(parseAuthMode("cleanup")).toBe("cleanup");
    expect(() => parseAuthMode("write")).toThrow(AppError);
  });
});

describe("filter validation", () => {
  it("applies conservative defaults for omitted protection switches", () => {
    const filters = parseFilters({ minAgeDays: 30, senderAllowlist: ["Boss@Example.com"] });
    expect(filters.includeStarred).toBe(false);
    expect(filters.includeUnread).toBe(false);
    expect(filters.includeImportant).toBe(false);
    expect(filters.senderAllowlist).toEqual(["boss@example.com"]);
    expect(filters.senderTargets).toEqual([]);
  });

  it("rejects negative or non-integer sizes and too many senders", () => {
    expect(() => parseFilters({ minAgeDays: -1 })).toThrow(AppError);
    expect(() => parseFilters({ minAgeDays: 1, minSizeBytes: 1.5 })).toThrow(AppError);
    expect(() => parseFilters({ minAgeDays: 1, minSizeBytes: -5 })).toThrow(AppError);
    expect(() =>
      parseFilters({
        minAgeDays: 1,
        senderTargets: Array.from({ length: 101 }, (_v, i) => `a${i}@example.com`),
      }),
    ).toThrow(AppError);
    expect(() => parseFilters({ minAgeDays: 1, senderTargets: ["not a sender"] })).toThrow(AppError);
  });

  it("keeps allowlist and target lists bounded and deduplicated", () => {
    const filters = parseFilters({
      minAgeDays: 1,
      senderTargets: ["example.com", "example.com"],
      senderAllowlist: ["ceo@example.com"],
    });
    expect(filters.senderTargets).toEqual(["example.com"]);
    expect(filters.senderAllowlist).toEqual(["ceo@example.com"]);
  });
});

describe("action/folder semantics", () => {
  it("restricts archive to the inbox", () => {
    expect(() => assertActionFolders("archive", ["inbox"])).not.toThrow();
    expect(() => assertActionFolders("archive", ["spam"])).toThrow(AppError);
    expect(() => assertActionFolders("archive", ["inbox", "spam"])).toThrow(AppError);
  });

  it("rejects moving trash to trash", () => {
    expect(() => assertActionFolders("trash", ["trash"])).toThrow(AppError);
    expect(() => assertActionFolders("trash", ["inbox", "trash"])).toThrow(AppError);
  });

  it("restricts empty trash to trash only", () => {
    expect(() => assertActionFolders("emptyTrash", ["trash"])).not.toThrow();
    expect(() => assertActionFolders("emptyTrash", ["inbox"])).toThrow(AppError);
  });

  it("has defaults that would not select an entire folder", () => {
    expect(BASE_FILTERS.minAgeDays).toBeGreaterThan(0);
    expect(BASE_FILTERS.includeStarred).toBe(false);
  });
});
