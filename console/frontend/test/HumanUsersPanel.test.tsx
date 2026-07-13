import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Toast } from "@douyinfe/semi-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BindingCode,
  HumanUser,
  HumanUserDetail,
  Identity,
  Platform,
  PlatformCredential,
  Pod,
} from "../src/api";
import { HumanUsersPanel } from "../src/components/human-users/HumanUsersPanel";

const apiMocks = vi.hoisted(() => ({
  listHumanUsers: vi.fn(),
  createHumanUser: vi.fn(),
  listLLMModels: vi.fn(),
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
  channels: ["wecom", "wechat"],
  maxUsers: 10,
  userCount: 1,
  availableSlots: 9,
  configGeneration: 2,
  appliedGeneration: 2,
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
  openclawChannel: "wecom-openclaw",
  accountId: "default",
  externalId: "EncryptedUserID",
  externalIdType: "user_id",
  peerKind: "direct",
  status: "active",
  createdAt: "2026-07-11T00:00:00Z",
  updatedAt: "2026-07-11T00:00:00Z",
};

const detail: HumanUserDetail = { humanUser: user, identities: [identity] };

const pendingBindingCode: BindingCode = {
  bindingCodeId: "binding-pending",
  codeHint: "MUAD-****-2345",
  humanUserId: "user-a",
  podId: "pod-a",
  channel: "wechat",
  openclawChannel: "wechat-openclaw",
  accountId: "default",
  purpose: "add_identity_to_existing_user",
  status: "pending",
  failedAttempts: 0,
  expiresAt: "2026-07-11T21:00:00Z",
  createdAt: "2026-07-11T20:00:00Z",
};

const expiredBindingCode: BindingCode = {
  ...pendingBindingCode,
  bindingCodeId: "binding-expired",
  codeHint: "MUAD-****-9876",
  status: "expired",
  expiresAt: "2026-07-11T19:00:00Z",
};

const xdrPlatform: Platform = {
  platform: "xdr",
  displayName: "XDR",
  config: { baseUrl: "https://xdr.internal" },
  configFingerprint: "sha256:xdr-config",
  enabled: false,
  adapterInstalled: true,
  updatedAt: "2026-07-11T00:00:00Z",
};

const xdrCredential: PlatformCredential = {
  humanUserId: "user-a",
  platform: "xdr",
  keyFingerprint: "sha256:user-xdr-key",
  platformEnabled: false,
  updatedAt: "2026-07-11T00:00:00Z",
};

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.listHumanUsers.mockResolvedValue({ items: [user], total: 1, page: 1, pageSize: 20 });
  apiMocks.getHumanUser.mockResolvedValue(detail);
  apiMocks.patchHumanUser.mockResolvedValue(detail);
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
  apiMocks.deleteHumanUser.mockResolvedValue({
    humanUserId: "user-a",
    podId: "pod-a",
    status: "deleting",
  });
  apiMocks.createIdentity.mockResolvedValue(identity);
  apiMocks.setIdentityStatus.mockResolvedValue({ ...identity, status: "disabled" });
  apiMocks.deleteIdentity.mockResolvedValue({
    humanUserId: "user-a",
    identityId: "identity-a",
    deleted: true,
  });
  apiMocks.listBindingCodes.mockResolvedValue({
    items: [pendingBindingCode, expiredBindingCode],
    total: 2,
  });
  apiMocks.createBindingCode.mockResolvedValue({
    bindingCode: pendingBindingCode,
    code: "MUAD-NEW-CODE",
  });
  apiMocks.revokeBindingCode.mockResolvedValue({ ...pendingBindingCode, status: "revoked" });
  apiMocks.listPlatforms.mockResolvedValue({ items: [xdrPlatform], total: 1 });
  apiMocks.listPlatformCredentials.mockResolvedValue({ items: [xdrCredential], total: 1 });
  apiMocks.putPlatformCredential.mockResolvedValue({
    credential: xdrCredential,
    cacheInvalidation: "on_next_resolve",
  });
  apiMocks.deletePlatformCredential.mockResolvedValue({
    humanUserId: "user-a",
    platform: "xdr",
    deleted: true,
    cacheInvalidation: "on_next_resolve",
  });
});

afterEach(() => Toast.destroyAll());

function renderPanel(panelPod: Pod = pod) {
  const onPodChanged = vi.fn().mockResolvedValue(undefined);
  render(<HumanUsersPanel pod={panelPod} onPodChanged={onPodChanged} />);
  return onPodChanged;
}

async function openCreateDialog() {
  await screen.findByText("Alice");
  fireEvent.click(screen.getByRole("button", { name: "创建用户" }));
}

async function openUserDetail() {
  await screen.findByText("Alice");
  fireEvent.click(screen.getByRole("button", { name: "详情" }));
  await screen.findByText("用户 ID");
}

describe("HumanUsersPanel", () => {
  it("keeps user creation visible when the Pod has no users", async () => {
    apiMocks.listHumanUsers.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderPanel({ ...pod, userCount: 0, availableSlots: 10 });

    expect(await screen.findByRole("button", { name: "创建用户" })).toBeInTheDocument();
    expect(screen.getByText("已分配用户")).toBeInTheDocument();
    expect(screen.getByText("剩余容量")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });

  it("shows status, agent, identity count, browser profile, and capacity", async () => {
    renderPanel();

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("已启用")).toBeInTheDocument();
    expect(screen.getAllByText("alice-agent")).toHaveLength(2);
    expect(screen.getByText("CDP 18801")).toBeInTheDocument();
    expect(screen.getByText("剩余容量")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
  });

  it("creates a user directly from a known external ID", async () => {
    apiMocks.createHumanUser.mockResolvedValue({ humanUser: user, identity });
    renderPanel();
    await openCreateDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "显示名称" }), {
      target: { value: "Alice" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "External ID" }), {
      target: { value: "EncryptedUserID" },
    });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(apiMocks.createHumanUser).toHaveBeenCalledWith("pod-a", {
        displayName: "Alice",
        modelConfigId: "model-new",
        agentId: undefined,
        notes: "",
        identity: {
          channel: "wecom",
          accountId: "default",
          externalId: "EncryptedUserID",
          externalIdType: "user_id",
          peerKind: "direct",
        },
      }),
    );
  });

  it("keeps create-user form input when the parent Pod refreshes", async () => {
    const onPodChanged = vi.fn().mockResolvedValue(undefined);
    const view = render(<HumanUsersPanel pod={pod} onPodChanged={onPodChanged} />);
    await openCreateDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "显示名称" }), {
      target: { value: "Typing Alice" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "External ID" }), {
      target: { value: "ExternalWhilePolling" },
    });

    view.rerender(
      <HumanUsersPanel
        pod={{ ...pod, userCount: 2, availableSlots: 8, updatedAt: "2026-07-11T00:05:00Z" }}
        onPodChanged={onPodChanged}
      />,
    );

    expect(screen.getByRole("textbox", { name: "显示名称" })).toHaveValue("Typing Alice");
    expect(screen.getByRole("textbox", { name: "External ID" })).toHaveValue(
      "ExternalWhilePolling",
    );
  });

  it("creates a pending user and shows the one-time binding code", async () => {
    apiMocks.createHumanUser.mockResolvedValue({
      humanUser: { ...user, status: "pending", identityCount: 0 },
      activation: {
        bindingCodeId: "binding-a",
        code: "MUAD-ABCD2345",
        expiresAt: "2026-07-11T01:00:00Z",
      },
    });
    renderPanel();
    await openCreateDialog();
    fireEvent.click(screen.getByRole("radio", { name: "绑定码激活" }));
    fireEvent.change(screen.getByRole("textbox", { name: "显示名称" }), {
      target: { value: "Pending Alice" },
    });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText("MUAD-ABCD2345")).toBeInTheDocument();
    expect(apiMocks.createHumanUser).toHaveBeenCalledWith(
      "pod-a",
      expect.objectContaining({
        displayName: "Pending Alice",
        modelConfigId: "model-new",
        activation: { channel: "wecom", accountId: "default", expiresInMinutes: 30 },
      }),
    );
  });

  it("shows bound model metadata without exposing the API key", async () => {
    renderPanel();
    await openUserDetail();

    expect(screen.getByText("运行 Agent")).toBeInTheDocument();
    expect(screen.getByText("浏览器配置")).toBeInTheDocument();
    expect(screen.getByText("已绑定 IM 数")).toBeInTheDocument();
    expect(screen.queryByText("Human User ID")).not.toBeInTheDocument();
    expect(screen.queryByText("Browser Profile")).not.toBeInTheDocument();
    expect(screen.getByText("deepseek/deepseek-chat")).toBeInTheDocument();
    expect(screen.getByText(/sha256:model-key/)).toBeInTheDocument();
    expect(screen.queryByLabelText("模型 API Key")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/sk-/)).not.toBeInTheDocument();
  });

  it("lists cleanup impact before deleting a Human User", async () => {
    const onPodChanged = renderPanel();
    await openUserDetail();
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);

    expect(screen.getByText(/workspace 与 private Skill/)).toBeInTheDocument();
    expect(screen.getByText(/浏览器配置与浏览器状态/)).toBeInTheDocument();
    expect(screen.getByText(/会话、记忆和 session-manager/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() => expect(apiMocks.deleteHumanUser).toHaveBeenCalledWith("user-a"));
    expect(onPodChanged).toHaveBeenCalled();
  });

  it("keeps save and delete actions in the dialog footer", async () => {
    renderPanel();
    await openUserDetail();

    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存基本信息" })).not.toBeInTheDocument();
    expect(document.querySelector(".standard-modal")).toBeInTheDocument();
  });

  it("shows scoped Identity fields and preserves the raw external ID", async () => {
    renderPanel();
    await openUserDetail();
    fireEvent.click(screen.getByRole("tab", { name: "身份标识" }));

    expect(screen.getByText("EncryptedUserID")).toBeInTheDocument();
    expect(screen.getByText("user_id")).toBeInTheDocument();
    expect(screen.getByText("wecom-openclaw")).toBeInTheDocument();
  });

  it("adds an Identity without normalizing its external ID", async () => {
    renderPanel();
    await openUserDetail();
    fireEvent.click(screen.getByRole("tab", { name: "身份标识" }));
    fireEvent.click(screen.getByRole("button", { name: "新增 Identity" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新增 Identity External ID" }), {
      target: { value: "Feishu-CaseSensitive-ID" },
    });
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() =>
      expect(apiMocks.createIdentity).toHaveBeenCalledWith(
        "user-a",
        expect.objectContaining({ externalId: "Feishu-CaseSensitive-ID", peerKind: "direct" }),
      ),
    );
  });

  it("changes Identity status and deletes it through explicit actions", async () => {
    renderPanel();
    await openUserDetail();
    fireEvent.click(screen.getByRole("tab", { name: "身份标识" }));

    fireEvent.click(screen.getByRole("button", { name: "停用" }));
    await waitFor(() =>
      expect(apiMocks.setIdentityStatus).toHaveBeenCalledWith("user-a", "identity-a", "disabled"),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    await waitFor(() =>
      expect(apiMocks.deleteIdentity).toHaveBeenCalledWith("user-a", "identity-a"),
    );
  });

  it("surfaces an Identity scoped conflict from the API", async () => {
    apiMocks.createIdentity.mockRejectedValue(new Error("Identity scope conflict"));
    renderPanel();
    await openUserDetail();
    fireEvent.click(screen.getByRole("tab", { name: "身份标识" }));
    fireEvent.click(screen.getByRole("button", { name: "新增 Identity" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新增 Identity External ID" }), {
      target: { value: "ExistingID" },
    });
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    expect(await screen.findByText("Identity scope conflict")).toBeInTheDocument();
  });

  it("shows binding status, revokes pending codes, and marks expired codes", async () => {
    renderPanel();
    await openUserDetail();
    fireEvent.click(screen.getByRole("tab", { name: "绑定码" }));

    expect(await screen.findByText("MUAD-****-2345")).toBeInTheDocument();
    expect(screen.getByText("已过期")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "吊销" })[0]);
    await waitFor(() =>
      expect(apiMocks.revokeBindingCode).toHaveBeenCalledWith("user-a", "binding-pending"),
    );
  });

  it("discards binding-code plaintext after the one-time dialog closes", async () => {
    renderPanel();
    await openUserDetail();
    fireEvent.click(screen.getByRole("tab", { name: "绑定码" }));
    await screen.findByText("MUAD-****-2345");
    fireEvent.click(screen.getByRole("button", { name: "生成绑定码" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    expect(await screen.findByText("MUAD-NEW-CODE")).toBeInTheDocument();
    const savedButton = screen.getByText("我已保存").closest("button");
    expect(savedButton).not.toBeNull();
    if (savedButton) fireEvent.click(savedButton);
    await waitFor(() => expect(screen.queryByText("MUAD-NEW-CODE")).not.toBeInTheDocument());
    expect(screen.getByText("MUAD-****-2345")).toBeInTheDocument();
  });

  it("shows a disabled platform and overwrites its credential without exposing the key", async () => {
    renderPanel();
    await openUserDetail();
    fireEvent.click(screen.getByRole("tab", { name: "平台凭证" }));

    expect(await screen.findByText("sha256:user-xdr-key")).toBeInTheDocument();
    expect(screen.getByText("已停用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "覆盖" }));
    const keyInput = screen.getByLabelText("业务平台 API Key");
    expect(keyInput).toHaveValue("");
    fireEvent.change(keyInput, { target: { value: "sensitive-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() =>
      expect(apiMocks.putPlatformCredential).toHaveBeenCalledWith(
        "user-a",
        "xdr",
        "sensitive-new-key",
      ),
    );
    expect(screen.queryByDisplayValue("sensitive-new-key")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive-new-key")).not.toBeInTheDocument();
  });

  it("adds a credential for an unconfigured platform", async () => {
    apiMocks.listPlatformCredentials.mockResolvedValue({ items: [], total: 0 });
    renderPanel();
    await openUserDetail();
    fireEvent.click(screen.getByRole("tab", { name: "平台凭证" }));

    await screen.findByText("未配置");
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    fireEvent.change(screen.getByLabelText("业务平台 API Key"), {
      target: { value: "first-platform-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() =>
      expect(apiMocks.putPlatformCredential).toHaveBeenCalledWith(
        "user-a",
        "xdr",
        "first-platform-key",
      ),
    );
  });

  it("deletes a configured platform credential through confirmation", async () => {
    renderPanel();
    await openUserDetail();
    fireEvent.click(screen.getByRole("tab", { name: "平台凭证" }));
    await screen.findByText("sha256:user-xdr-key");
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() =>
      expect(apiMocks.deletePlatformCredential).toHaveBeenCalledWith("user-a", "xdr"),
    );
  });
});
