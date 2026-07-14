import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HumanUser, HumanUserDetail, Identity, Pod } from "../src/api";
import { Users } from "../src/pages/Users";

const apiMocks = vi.hoisted(() => ({
  listAllHumanUsers: vi.fn(),
  listPods: vi.fn(),
  listLLMModels: vi.fn(),
  createHumanUser: vi.fn(),
  getHumanUser: vi.fn(),
  patchHumanUser: vi.fn(),
  deleteHumanUser: vi.fn(),
  createIdentity: vi.fn(),
  setIdentityStatus: vi.fn(),
  deleteIdentity: vi.fn(),
  listBindingCodes: vi.fn(),
  createBindingCode: vi.fn(),
  revokeBindingCode: vi.fn(),
  listPlatforms: vi.fn(),
  listPlatformCredentials: vi.fn(),
  putPlatformCredential: vi.fn(),
  deletePlatformCredential: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

const pod: Pod = {
  podId: "pod-a",
  displayName: "Pod A",
  imageTag: "muad-openclaw:test",
  state: "running",
  channels: ["wecom"],
  maxUsers: 10,
  userCount: 1,
  availableSlots: 9,
  configGeneration: 1,
  appliedGeneration: 1,
  generationLag: 0,
  lastApplyStatus: "applied",
  serviceTokenFingerprint: "sha256:service",
  cpuPercent: 0,
  memMiB: 0,
  skillActive: 0,
  skillQueued: 0,
  browserActive: 0,
  browserQueued: 0,
  runtimeGuardHealthy: true,
  createdAt: "2026-07-11T00:00:00Z",
  updatedAt: "2026-07-11T00:00:00Z",
};

const fullPod: Pod = {
  ...pod,
  podId: "pod-full",
  displayName: "Full Pod",
  userCount: 10,
  availableSlots: 0,
};

const sparePod: Pod = {
  ...pod,
  podId: "pod-b",
  displayName: "Pod B",
  userCount: 0,
  availableSlots: 10,
};

const user: HumanUser = {
  humanUserId: "user-a",
  podId: "pod-a",
  modelConfigId: "model-a",
  displayName: "Alice",
  agentId: "alice-agent",
  browserProfile: "alice-agent",
  browserCdpPort: 18801,
  status: "active",
  notes: "operator",
  identityCount: 1,
  modelConfig: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    keyConfigured: true,
    keyFingerprint: "sha256:model-key",
  },
  createdAt: "2026-07-11T00:00:00Z",
  updatedAt: "2026-07-11T00:00:00Z",
};

const identity: Identity = {
  identityId: "identity-a",
  channel: "wecom",
  openclawChannel: "wecom",
  accountId: "default",
  externalId: "ExternalAlice",
  externalIdType: "user_id",
  peerKind: "direct",
  status: "active",
  createdAt: "2026-07-11T00:00:00Z",
  updatedAt: "2026-07-11T00:00:00Z",
};

const detail: HumanUserDetail = { humanUser: user, identities: [identity] };

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.listAllHumanUsers.mockResolvedValue({
    items: [user],
    total: 1,
    page: 1,
    pageSize: 20,
  });
  apiMocks.listPods.mockResolvedValue({ items: [pod], total: 1, page: 1, pageSize: 100 });
  apiMocks.listLLMModels.mockResolvedValue({
    items: [
      {
        modelConfigId: "model-new",
        displayName: "New Model",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        keyConfigured: true,
        keyFingerprint: "sha256:new-model-key",
        createdAt: "2026-07-11T00:00:00Z",
        updatedAt: "2026-07-11T00:00:00Z",
      },
    ],
    total: 1,
  });
  apiMocks.createHumanUser.mockResolvedValue({ humanUser: user, identity });
  apiMocks.getHumanUser.mockResolvedValue(detail);
  apiMocks.patchHumanUser.mockResolvedValue(detail);
  apiMocks.deleteHumanUser.mockResolvedValue({
    humanUserId: "user-a",
    podId: "pod-a",
    status: "deleting",
  });
  apiMocks.listBindingCodes.mockResolvedValue({ items: [], total: 0 });
  apiMocks.listPlatforms.mockResolvedValue({ items: [], total: 0 });
  apiMocks.listPlatformCredentials.mockResolvedValue({ items: [], total: 0 });
});

describe("Users", () => {
  it("lists users across Pods with bound LLM configuration", async () => {
    const onOpenPod = vi.fn();
    render(<Users onOpenPod={onOpenPod} />);

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Pod A")).toBeInTheDocument();
    expect(screen.getByText("deepseek/deepseek-chat")).toBeInTheDocument();
    expect(screen.getByText("sha256:model-key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建用户" })).toBeInTheDocument();
    expect(apiMocks.listAllHumanUsers).toHaveBeenCalledWith({
      page: 1,
      pageSize: 10,
      q: "",
      status: undefined,
    });
    fireEvent.click(screen.getByRole("button", { name: "Pod A" }));
    expect(onOpenPod).toHaveBeenCalledWith("pod-a");
  });

  it("creates a user from the global list and skips full Pods", async () => {
    apiMocks.listPods.mockResolvedValue({
      items: [fullPod, sparePod],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    render(<Users onOpenPod={vi.fn()} />);

    await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "创建用户" }));

    expect(await screen.findByText("Pod B (pod-b) 0/10")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "显示名称" }), {
      target: { value: "Bob" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "External ID" }), {
      target: { value: "ExternalBob" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(apiMocks.createHumanUser).toHaveBeenCalledWith("pod-b", {
        displayName: "Bob",
        modelConfigId: "model-new",
        agentId: undefined,
        notes: "",
        identity: {
          channel: "wecom",
          accountId: "default",
          externalId: "ExternalBob",
          externalIdType: "user_id",
          peerKind: "direct",
        },
      }),
    );
  });

  it("opens the same detail operations used by the Pod-scoped list", async () => {
    render(<Users onOpenPod={vi.fn()} />);

    await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(await screen.findByText("用户详情 Alice")).toBeInTheDocument();
    expect(screen.getByText("已绑定 IM 数")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "身份标识" })).toBeInTheDocument();
    expect(apiMocks.getHumanUser).toHaveBeenCalledWith("user-a");
  });

  it("deletes a Human User from the list actions", async () => {
    render(<Users onOpenPod={vi.fn()} />);

    await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "删除用户 Alice" }));
    expect(screen.getByText(/workspace 与 private Skill/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() => expect(apiMocks.deleteHumanUser).toHaveBeenCalledWith("user-a"));
    await waitFor(() => expect(apiMocks.listAllHumanUsers).toHaveBeenCalledTimes(2));
  });
});
