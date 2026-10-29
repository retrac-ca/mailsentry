import { describe, expect, it } from "vitest";
import { PlanStore, assertExecutionAllowed, computePlanHash, type StoredPlan } from "../../src/core/plan.js";
import type { ExecuteRequest } from "../../src/shared/types.js";
import { BASE_FILTERS, NOW, makePlan } from "../helpers/fixtures.js";
import { AppError } from "../../src/core/errors.js";

function request(plan: StoredPlan, overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    planId: plan.planId,
    planHash: plan.planHash,
    reviewToken: plan.reviewToken,
    mode: "execute",
    ...overrides,
  };
}

describe("cleanup plan hashing", () => {
  it("is stable regardless of entry order", () => {
    const a = computePlanHash({
      provider: "microsoft",
      folders: ["inbox"],
      filters: BASE_FILTERS,
      action: "trash",
      entries: [
        { id: "b", folder: "inbox" },
        { id: "a", folder: "inbox" },
      ],
    });
    const b = computePlanHash({
      provider: "microsoft",
      folders: ["inbox"],
      filters: BASE_FILTERS,
      action: "trash",
      entries: [
        { id: "a", folder: "inbox" },
        { id: "b", folder: "inbox" },
      ],
    });
    expect(a).toBe(b);
  });

  it("changes when folders, filters, or messages change", () => {
    const base = {
      provider: "microsoft" as const,
      folders: ["inbox" as const],
      filters: BASE_FILTERS,
      action: "trash" as const,
      entries: [{ id: "a", folder: "inbox" as const }],
    };
    const original = computePlanHash(base);
    expect(computePlanHash({ ...base, folders: ["inbox", "spam"] })).not.toBe(original);
    expect(computePlanHash({ ...base, entries: [{ id: "b", folder: "inbox" }] })).not.toBe(original);
    expect(computePlanHash({ ...base, filters: { ...BASE_FILTERS, minAgeDays: 30 } })).not.toBe(original);
    expect(computePlanHash({ ...base, action: "archive" })).not.toBe(original);
  });
});

describe("execution gate", () => {
  it("accepts a matching dry-run plan", () => {
    const { plan } = makePlan();
    expect(plan.ownerSessionId).toBe("test-session");
    expect(plan.connectionToken).toBe("test-connection");
    expect(() => assertExecutionAllowed(plan, request(plan, { mode: "dry-run" }), NOW)).not.toThrow();
  });

  it("requires an exact typed confirmation for permanent deletion", () => {
    const { plan } = makePlan({ action: "permanentDelete" });
    expect(() => assertExecutionAllowed(plan, request(plan), NOW)).toThrow(AppError);
    expect(() =>
      assertExecutionAllowed(plan, request(plan, { confirmation: "delete permanently" }), NOW),
    ).toThrow(AppError);
    expect(() =>
      assertExecutionAllowed(plan, request(plan, { confirmation: "DELETE PERMANENTLY" }), NOW),
    ).not.toThrow();
  });

  it("requires confirmation for Empty Trash too", () => {
    const { plan } = makePlan({
      folders: ["trash"],
      action: "emptyTrash",
      entries: [{ id: "t", folder: "trash" }],
    });
    expect(() => assertExecutionAllowed(plan, request(plan), NOW)).toThrow(AppError);
    expect(() =>
      assertExecutionAllowed(plan, request(plan, { confirmation: "DELETE PERMANENTLY" }), NOW),
    ).not.toThrow();
  });

  it("does not require a typed phrase for reversible actions", () => {
    const { plan } = makePlan({ action: "archive" });
    expect(() => assertExecutionAllowed(plan, request(plan), NOW)).not.toThrow();
  });

  it("rejects a changed plan hash", () => {
    const { plan } = makePlan();
    expect(() => assertExecutionAllowed(plan, request(plan, { planHash: "0".repeat(64) }), NOW)).toThrow(
      /changed after review/i,
    );
  });

  it("rejects a missing or incorrect review token", () => {
    const { plan } = makePlan();
    expect(() => assertExecutionAllowed(plan, request(plan, { reviewToken: "wrong" }), NOW)).toThrow(
      /review token/i,
    );
    expect(() => assertExecutionAllowed(plan, request(plan, { reviewToken: "" }), NOW)).toThrow(AppError);
  });

  it("rejects expired plans", () => {
    const { plan } = makePlan({ ttlMs: 1000 });
    expect(() => assertExecutionAllowed(plan, request(plan), NOW + 5000)).toThrow(/expired/i);
  });

  it("rejects unsupported provider actions even with confirmation", () => {
    const { plan } = makePlan({ provider: "gmail", action: "permanentDelete" });
    expect(() =>
      assertExecutionAllowed(plan, request(plan, { confirmation: "DELETE PERMANENTLY" }), NOW),
    ).toThrow(/does not support/i);
  });

  it("rejects an unknown mode", () => {
    const { plan } = makePlan();
    expect(() =>
      assertExecutionAllowed(plan, request(plan, { mode: "force" as unknown as "execute" }), NOW),
    ).toThrow(/Unknown execution mode/);
  });
});

describe("plan store", () => {
  it("consumes a plan exactly once", () => {
    const { store, preview } = makePlan();
    expect(store.take(preview.planId)?.planId).toBe(preview.planId);
    expect(store.take(preview.planId)).toBeUndefined();
  });

  it("drops expired plans", () => {
    const { store, preview } = makePlan({ ttlMs: 1000 });
    expect(store.get(preview.planId, NOW + 2000)).toBeUndefined();
  });

  it("bounds stored plans and preview samples", () => {
    const store = new PlanStore(60_000, 2);
    const make = (index: number) =>
      store.create(
        {
          sessionId: "test-session",
          connectionToken: "test-connection",
          provider: "microsoft",
          folders: ["inbox"],
          filters: BASE_FILTERS,
          action: "trash",
          entries: Array.from({ length: 150 }, (_v, i) => ({
            id: `${index}-${i}`,
            folder: "inbox" as const,
          })),
          scannedCount: 150,
          eligibleBytes: 0,
          uncertainCount: 0,
          byFolder: [],
          sample: Array.from({ length: 150 }, (_v, i) => ({
            id: `${index}-${i}`,
            folder: "inbox" as const,
            subject: null,
            from: null,
            receivedAt: new Date(NOW).toISOString(),
            sizeBytes: null,
            bulk: { level: "none" as const, evidence: null },
            uncertain: false,
          })),
          sampleTruncated: true,
          warnings: [],
          limitations: [],
          ttlMs: 60_000,
        },
        NOW,
      );
    const first = make(1);
    const second = make(2);
    const third = make(3);
    expect(first.sample).toHaveLength(100);
    expect(store.size()).toBe(2);
    expect(store.get(second.planId, NOW)).toBeDefined();
    expect(store.get(third.planId, NOW)).toBeDefined();
  });
});
