import { describe, expect, it } from "vitest";
import { checkProviderConnection } from "../../src/core/connection-check.js";
import { capabilitiesFor } from "../../src/core/capabilities.js";
import { makeMessages, makeProvider, NOW } from "../helpers/fixtures.js";
import { SyntheticProvider } from "../../src/providers/synthetic.js";
import { ProviderError } from "../../src/providers/errors.js";

describe("read-only provider connection check", () => {
  it("reports folder access and counts without mutating messages", async () => {
    const provider = makeProvider([...makeMessages(2, "inbox"), ...makeMessages(1, "spam")]);
    const result = await checkProviderConnection(provider, { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("microsoft");
    expect(result.mode).toBe("cleanup");
    expect(result.checkedAt).toBe(new Date(NOW).toISOString());
    expect(result.folders.map((folder) => [folder.folder, folder.accessible, folder.messageCount])).toEqual([
      ["inbox", true, 2],
      ["spam", true, 1],
      ["trash", true, 0],
    ]);
    expect(provider.getMutations()).toEqual([]);
    expect(provider.getCallCounts().archive).toBe(0);
    expect(provider.getCallCounts().trash).toBe(0);
    expect(provider.getCallCounts().permanentDelete).toBe(0);
  });

  it("explains that read-only checks do not test mutations", async () => {
    const provider = makeProvider(makeMessages(1), { mode: "readonly" });
    const result = await checkProviderConnection(provider, { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/read-only/i);
    expect(result.warnings.join(" ")).toMatch(/reconnect/i);
  });

  it("reports per-folder failures without claiming success", async () => {
    const provider = makeProvider(makeMessages(1), {
      failures: [
        {
          operation: "list",
          times: 1,
          error: new ProviderError("Access denied for this folder.", {
            code: "FORBIDDEN",
            status: 403,
          }),
        },
      ],
    });
    const result = await checkProviderConnection(provider, { now: NOW });
    expect(result.ok).toBe(false);
    const inbox = result.folders.find((folder) => folder.folder === "inbox");
    expect(inbox?.accessible).toBe(false);
    expect(inbox?.error).toContain("Access denied");
    expect(result.warnings.join(" ")).toMatch(/failed/i);
    expect(provider.getMutations()).toEqual([]);
  });

  it("marks unsupported folders explicitly", async () => {
    const capabilities = capabilitiesFor("microsoft");
    const provider = new SyntheticProvider(makeMessages(1, "trash"), {
      providerId: "microsoft",
      capabilities: {
        ...capabilities,
        folders: {
          ...capabilities.folders,
          trash: {
            supported: false,
            displayName: "Deleted Items",
            reason: "Not exposed to this integration.",
            confirmationRequired: false,
          },
        },
      },
    });
    const result = await checkProviderConnection(provider, { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.folders.find((folder) => folder.folder === "trash")?.error).toMatch(/Not exposed/);
  });

  it("honours cancellation before making provider calls", async () => {
    const provider = makeProvider(makeMessages(1));
    const controller = new AbortController();
    controller.abort();
    await expect(checkProviderConnection(provider, { signal: controller.signal })).rejects.toThrow();
    expect(provider.getMutations()).toEqual([]);
  });
});
