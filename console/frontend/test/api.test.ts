import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

function mockFetch() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        code: 0,
        data: { loginUrl: "https://liteapp.weixin.qq.com/q/test", raw: "", connected: false },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("api.qrcode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the normal QR endpoint by default", async () => {
    const fetchMock = mockFetch();
    await api.qrcode("alice");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/containers/alice/qrcode",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("adds force=true when requesting a re-scan QR", async () => {
    const fetchMock = mockFetch();
    await api.qrcode("alice", true);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/containers/alice/qrcode?force=true",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("api.reloadSkills", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts selected user IDs", async () => {
    const fetchMock = mockFetch();
    await api.reloadSkills(["alice", "bob"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/skills/reload",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ userIds: ["alice", "bob"] }),
      }),
    );
  });
});
