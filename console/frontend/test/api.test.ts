import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, token, UNAUTHORIZED_EVENT } from "../src/api";

function success(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubResponse(data: unknown = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(success(data)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  token.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Pod API", () => {
  it("encodes pagination and filters in the Pod list URL", async () => {
    const fetchMock = stubResponse({ items: [], total: 0, page: 2, pageSize: 50 });

    await api.listPods({ page: 2, pageSize: 50, q: "生产 pod", state: "running" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/containers?page=2&pageSize=50&q=%E7%94%9F%E4%BA%A7+pod&state=running",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("uses explicit deleteState semantics", async () => {
    const fetchMock = stubResponse({ podId: "pod-a", deleted: true, stateRetained: true });

    await api.deletePod("pod-a", false);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/containers/pod-a?deleteState=false",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("uses the normal QR endpoint by default and force on rescan", async () => {
    const fetchMock = stubResponse({ loginUrl: "https://example.test/qr", raw: "", connected: false });
    await api.qrcode("pod-a");
    await api.qrcode("pod-a", true);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/containers/pod-a/qrcode",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/containers/pod-a/qrcode?force=true",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("posts Pod IDs for Skill reload and LLM apply", async () => {
    const fetchMock = stubResponse({ results: { "pod-a": "queued" } });
    await api.reloadSkills(["pod-a", "pod-b"]);
    await api.applyLLM(["pod-a"]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/skills/reload",
      expect.objectContaining({ body: JSON.stringify({ podIds: ["pod-a", "pod-b"] }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/llm/apply",
      expect.objectContaining({ body: JSON.stringify({ podIds: ["pod-a"] }) }),
    );
  });
});

describe("Human User and credential API", () => {
  it("posts the direct Identity bootstrap payload without changing external ID", async () => {
    const fetchMock = stubResponse({ humanUser: {}, identity: {} });
    const input = {
      displayName: "Alice",
      identity: {
        channel: "wecom",
        accountId: "default",
        externalId: "Encrypted-ID_AbC",
        externalIdType: "user_id",
        peerKind: "direct" as const,
      },
    };

    await api.createHumanUser("pod-a", input);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/containers/pod-a/human-users",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
    );
  });

  it("encodes Human User, platform, and binding-code path segments", async () => {
    const fetchMock = stubResponse({ bindingCodeId: "binding/id", status: "revoked" });

    await api.revokeBindingCode("user/id", "binding/id");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/human-users/user%2Fid/binding-codes/binding%2Fid",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("sends a credential only in the write payload and consumes a redacted response", async () => {
    const credential = {
      humanUserId: "user-a",
      platform: "mssw",
      keyFingerprint: "sha256:abcd",
      platformEnabled: true,
      updatedAt: "2026-07-11T00:00:00Z",
    };
    const fetchMock = stubResponse({ credential, cacheInvalidation: "on_next_resolve" });

    const result = await api.putPlatformCredential("user-a", "mssw", "test-api-key");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/human-users/user-a/platform-credentials/mssw",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ apiKey: "test-api-key" }) }),
    );
    expect(result.credential).toEqual(credential);
    expect(result.credential).not.toHaveProperty("apiKey");
  });
});

describe("request contract", () => {
  it("preserves the bearer auth header", async () => {
    const fetchMock = stubResponse({ actor: "admin" });
    token.set("test-console-token");

    await api.me();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/me",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-console-token" }),
      }),
    );
  });

  it("clears the token and emits the unauthorized event on 401", async () => {
    token.set("expired-token");
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener, { once: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 40101, message: "unauthorized" }), { status: 401 }),
      ),
    );

    await expect(api.me()).rejects.toMatchObject({ status: 401, code: 40101 });
    expect(token.get()).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("exposes backend status and error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 40903, message: "Pod capacity exceeded" }), {
          status: 409,
        }),
      ),
    );

    const failure = api.createPod({ podId: "pod-a" });
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 409, code: 40903 });
  });

  it("rejects malformed success envelopes and invalid JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(success({ actor: "admin" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ actor: "admin" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.me()).resolves.toEqual({ actor: "admin" });
    await expect(api.me()).rejects.toThrow("服务端响应格式无效");
    await expect(api.me()).rejects.toThrow("服务端返回了无效 JSON");
  });
});
