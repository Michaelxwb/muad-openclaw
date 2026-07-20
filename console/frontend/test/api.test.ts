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
    const fetchMock = stubResponse({
      loginUrl: "https://example.test/qr",
      raw: "",
      connected: false,
    });
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

  it("posts Pod IDs for Skill reload", async () => {
    const fetchMock = stubResponse({ results: { "pod-a": "queued" } });
    await api.reloadSkills(["pod-a", "pod-b"]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/skills/reload",
      expect.objectContaining({ body: JSON.stringify({ podIds: ["pod-a", "pod-b"] }) }),
    );
  });

  it("posts an empty body for global Skill apply", async () => {
    const fetchMock = stubResponse({ results: { "pod-a": "queued" } });
    await api.applySkills();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/skills/reload",
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });
});

describe("Human User and credential API", () => {
  it("posts the direct Identity bootstrap payload without changing external ID", async () => {
    const fetchMock = stubResponse({ humanUser: {}, identity: {} });
    const input = {
      displayName: "Alice",
      modelConfigId: "model-a",
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

  it("encodes global Human User list filters", async () => {
    const fetchMock = stubResponse({ items: [], total: 0, page: 2, pageSize: 20 });

    await api.listAllHumanUsers({ page: 2, pageSize: 20, q: "Alice pod-a", status: "active" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/human-users?page=2&pageSize=20&q=Alice+pod-a&status=active",
      expect.objectContaining({ method: "GET" }),
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

describe("Skill API", () => {
  it("encodes Skill list filters and execution query filters", async () => {
    const fetchMock = stubResponse({ items: [], total: 0, page: 1, pageSize: 10 });

    await api.listSkills({
      page: 1,
      pageSize: 10,
      q: "xdr",
      scope: "private",
      status: "active",
      humanUserId: "user/a",
      podId: "pod-a",
    });
    await api.listSkillExecutions({
      page: 2,
      pageSize: 50,
      q: "xdr-query",
      status: "failed",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/skills?page=1&pageSize=10&q=xdr&scope=private&status=active&humanUserId=user%2Fa&podId=pod-a",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/skill-executions?page=2&pageSize=50&q=xdr-query&status=failed",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("encodes every Skill execution filter and omits blank values", async () => {
    const fetchMock = stubResponse({ items: [], total: 0, page: 3, pageSize: 20 });

    await api.listSkillExecutions({
      page: 3,
      pageSize: 20,
      q: "",
      podId: "pod/a",
      humanUserId: "",
      agentId: "agent-a",
      skillName: "report skill",
      scope: "private",
      entryType: "traditional-script",
      status: "rejected",
      startedFrom: "2026-07-14T01:00:00Z",
      startedTo: "2026-07-14T02:00:00Z",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/skill-executions?page=3&pageSize=20&podId=pod%2Fa&agentId=agent-a&skillName=report+skill&scope=private&entryType=traditional-script&status=rejected&startedFrom=2026-07-14T01%3A00%3A00Z&startedTo=2026-07-14T02%3A00%3A00Z",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("loads a Skill execution detail through an encoded path", async () => {
    const detail = {
      executionId: "run/a",
      status: "succeeded",
      progressJson: null,
    };
    const fetchMock = stubResponse(detail);

    const result = await api.getSkillExecution("run/a");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/skill-executions/run%2Fa",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toEqual(detail);
  });

  it("uploads private Skill bundles as multipart with auth but without JSON content type", async () => {
    const fetchMock = stubResponse({ skill: { skillId: "skill-a", name: "xdr-query" } });
    token.set("console-token");

    await api.uploadPrivateSkill("user-a", {
      bundle: new Blob(["bundle"]),
      filename: "xdr-query.tar.gz",
      expectedName: "xdr-query",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/human-users/user-a/skills/private");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer console-token" });
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("uploads public Skill bundles through the global endpoint", async () => {
    const fetchMock = stubResponse({
      skill: { skillId: "skill-a", name: "xdr-public" },
      affectedPodIds: ["pod-a"],
    });
    token.set("console-token");

    await api.uploadPublicSkill({
      bundle: new Blob(["bundle"]),
      filename: "xdr-public.zip",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/skills/public");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer console-token" });
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("posts Skill status and user policies through the typed client", async () => {
    const fetchMock = stubResponse({});

    await api.updateSkill("skill/a", { status: "disabled" });
    await api.createSkillPolicy("user/a", {
      skillName: "xdr-query",
      action: "allow_override",
      reason: "approved",
    });
    await api.deleteSkillPolicy("user/a", "policy/a");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/skills/skill%2Fa",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "disabled" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/human-users/user%2Fa/skill-policies",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          skillName: "xdr-query",
          action: "allow_override",
          reason: "approved",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/v1/human-users/user%2Fa/skill-policies/policy%2Fa",
      expect.objectContaining({ method: "DELETE" }),
    );
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
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 40101, message: "unauthorized" }), { status: 401 }),
        ),
    );

    await expect(api.me()).rejects.toMatchObject({ status: 401, code: 40101 });
    expect(token.get()).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not clear a stored token when login returns 401", async () => {
    token.set("still-valid-session");
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener, { once: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 40101, message: "invalid credentials" }), {
          status: 401,
        }),
      ),
    );

    await expect(api.login("root", "bad")).rejects.toMatchObject({
      status: 401,
      code: 40101,
      message: "用户名或密码错误",
    });
    expect(token.get()).toBe("still-valid-session");
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not treat unauthenticated 401 responses as session expiry", async () => {
    token.clear();
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener, { once: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 40101, message: "unauthorized" }), { status: 401 }),
      ),
    );

    await expect(api.me()).rejects.toMatchObject({
      status: 401,
      code: 40101,
      message: "用户名或密码错误",
    });
    expect(token.get()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
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
