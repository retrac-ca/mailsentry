import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../../src/core/batch.js";
import { GmailProvider } from "../../src/providers/gmail.js";
import { MicrosoftProvider } from "../../src/providers/microsoft.js";
import { ProviderError } from "../../src/providers/errors.js";
import { providerRequest } from "../../src/providers/http.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gmail adapter (mocked transport)", () => {
  it("lists paginated metadata and classifies bulk headers without mutating", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/messages?")) {
        return jsonResponse({
          messages: [{ id: "m1" }, { id: "m2" }],
          nextPageToken: "page-2",
        });
      }
      if (url.includes("/messages/m1")) {
        return jsonResponse({
          id: "m1",
          labelIds: ["INBOX", "UNREAD"],
          internalDate: "1600000000000",
          sizeEstimate: 1234,
          payload: {
            headers: [
              { name: "From", value: "News <news@example.com>" },
              { name: "Subject", value: "=?UTF-8?B?SGVsbG8=?=" },
              { name: "List-Unsubscribe", value: "<mailto:unsub@example.com>" },
            ],
          },
        });
      }
      if (url.includes("/messages/m2")) {
        return jsonResponse({
          id: "m2",
          labelIds: ["SPAM"],
          internalDate: "1600000000001",
          sizeEstimate: 42,
          payload: { headers: [{ name: "From", value: "a@example.org" }] },
        });
      }
      return jsonResponse({ error: { message: "unexpected" } }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GmailProvider({
      accessToken: async () => "test-token",
      mode: "cleanup",
      account: "test@example.com",
      limiter: new RateLimiter(1000, 1000),
    });
    const page = await provider.listMessages("inbox", null);
    expect(page.nextPageToken).toBe("page-2");
    expect(page.messages).toHaveLength(2);
    const first = page.messages[0];
    expect(first?.folder).toBe("inbox");
    expect(first?.isRead).toBe(false);
    expect(first?.sizeBytes).toBe(1234);
    expect(first?.subject).toBe("Hello");
    expect(first?.bulk.level).toBe("likely");
    expect(page.messages[1]?.folder).toBe("inbox");
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as
      Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer test-token");
  });

  it("refuses mutations in read-only mode without calling the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GmailProvider({
      accessToken: async () => "token",
      mode: "readonly",
      account: null,
      limiter: new RateLimiter(1000, 1000),
    });
    await expect(provider.archive("m1")).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.moveToTrash("m1")).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.permanentlyDelete("m1")).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("separates trash, spam, inbox, and archived labels on revalidation", async () => {
    const labels: Record<string, string[]> = {
      t: ["TRASH"],
      s: ["SPAM"],
      i: ["INBOX"],
      o: ["Label_1"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const match = /messages\/([a-z])\?/.exec(String(input));
        const id = match?.[1] ?? "x";
        return jsonResponse({
          id,
          labelIds: labels[id] ?? [],
          internalDate: "1600000000000",
          sizeEstimate: 10,
          payload: { headers: [] },
        });
      }),
    );
    const provider = new GmailProvider({
      accessToken: async () => "token",
      mode: "readonly",
      account: null,
      limiter: new RateLimiter(1000, 1000),
    });
    expect((await provider.getMessage("t"))?.folder).toBe("trash");
    expect((await provider.getMessage("s"))?.folder).toBe("spam");
    expect((await provider.getMessage("i"))?.folder).toBe("inbox");
    expect((await provider.getMessage("o"))?.folder).toBe("other");
  });
});

describe("Microsoft Graph adapter (mocked transport)", () => {
  it("maps Graph message fields and refuses unsafe pagination hosts", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/me/mailFolders/inbox?")) return jsonResponse({ id: "inbox-id" });
      if (url.includes("/mailFolders/inbox-id/messages")) {
        return jsonResponse({
          value: [
            {
              id: "g1",
              subject: "Hello",
              from: { emailAddress: { address: "sender@example.com", name: "Sender" } },
              receivedDateTime: "2025-01-01T00:00:00Z",
              size: 5000,
              hasAttachments: true,
              isRead: true,
              isDraft: false,
              flag: { flagStatus: "flagged" },
              importance: "high",
              parentFolderId: "inbox-id",
            },
          ],
          "@odata.nextLink": "https://evil.example/v1.0/steal",
        });
      }
      return jsonResponse({ error: {} }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new MicrosoftProvider({
      accessToken: async () => "token",
      mode: "cleanup",
      account: "user@example.com",
      limiter: new RateLimiter(1000, 1000),
    });
    await expect(provider.listMessages("inbox", null)).rejects.toThrow(/pagination host/i);
  });

  it("maps message metadata and archive destination", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/me/mailFolders/archive?")) return jsonResponse({ id: "archive-id" });
      if (url.includes("/me/mailFolders/deleteditems?")) return jsonResponse({ id: "trash-id" });
      if (url.includes("/me/mailFolders/inbox?")) return jsonResponse({ id: "inbox-id" });
      if (url.includes("/me/mailFolders/junkemail?")) return jsonResponse({ id: "spam-id" });
      if (url.includes("/me/messages/g1?")) {
        return jsonResponse({
          id: "g1",
          subject: "Hello",
          from: { emailAddress: { address: "sender@example.com" } },
          receivedDateTime: "2025-01-01T00:00:00Z",
          size: 5000,
          hasAttachments: true,
          isRead: true,
          isDraft: false,
          flag: { flagStatus: "flagged" },
          importance: "high",
          parentFolderId: "inbox-id",
        });
      }
      if (url.includes("/me/messages/g1/move") && init?.method === "POST") {
        return jsonResponse({ id: "g1" }, 201);
      }
      return jsonResponse({ error: { message: "unexpected" } }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new MicrosoftProvider({
      accessToken: async () => "token",
      mode: "cleanup",
      account: "user@example.com",
      limiter: new RateLimiter(1000, 1000),
    });
    const message = await provider.getMessage("g1");
    expect(message?.folder).toBe("inbox");
    expect(message?.isStarred).toBe(true);
    expect(message?.isImportant).toBe(true);
    await provider.archive("g1");
    const moveCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/move"));
    expect(moveCall).toBeTruthy();
    expect(JSON.parse(String((moveCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      destinationId: "archive-id",
    });
  });

  it("refuses mutations in read-only mode", async () => {
    const provider = new MicrosoftProvider({
      accessToken: async () => "token",
      mode: "readonly",
      account: null,
      limiter: new RateLimiter(1000, 1000),
    });
    await expect(provider.permanentlyDelete("g1")).rejects.toThrow(/read-only/i);
  });
});

describe("provider HTTP policy", () => {
  it("retries an explicit 429 and succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "0" },
          });
        }
        return jsonResponse({ ok: true });
      }),
    );
    const response = await providerRequest({
      provider: "Test",
      url: "https://example.test/read",
      limiter: new RateLimiter(1000, 1000),
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("does not retry ambiguous 5xx mutation failures", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response("server error", { status: 500 });
      }),
    );
    await expect(
      providerRequest({
        provider: "Test",
        url: "https://example.test/delete",
        method: "POST",
        idempotent: false,
        limiter: new RateLimiter(1000, 1000),
      }),
    ).rejects.toMatchObject({ status: 500, retryable: true });
    expect(calls).toBe(1);
  });

  it("maps 401 to an actionable authorization error without leaking headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    await expect(
      providerRequest({
        provider: "Test",
        url: "https://example.test/read",
        headers: { Authorization: "Bearer super-secret" },
        limiter: new RateLimiter(1000, 1000),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
