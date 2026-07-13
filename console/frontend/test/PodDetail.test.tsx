import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Toast } from "@douyinfe/semi-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pod, PodResourceConfig } from "../src/api";
import { PodDetail } from "../src/pages/PodDetail";

const apiMocks = vi.hoisted(() => ({
  getPod: vi.fn(),
  getPodResources: vi.fn(),
  listHumanUsers: vi.fn(),
  action: vi.fn(),
  applyPodConfig: vi.fn(),
  deletePod: vi.fn(),
  upgrade: vi.fn(),
  logs: vi.fn(),
  qrcode: vi.fn(),
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
  channelConfigs: { wecom: { botId: "bot-a", secretConfigured: true } },
  channelStatuses: { wecom: true, wechat: false },
  maxUsers: 10,
  userCount: 2,
  availableSlots: 8,
  configGeneration: 3,
  appliedGeneration: 2,
  generationLag: 1,
  lastApplyStatus: "failed",
  lastApplyError: "runtime rejected generation",
  serviceTokenFingerprint: "sha256:service",
  cpuPercent: 2.1,
  memMiB: 512,
  skillActive: 1,
  skillQueued: 0,
  browserActive: 0,
  browserQueued: 1,
  runtimeGuardHealthy: false,
  createdAt: "2026-07-11T00:00:00Z",
  updatedAt: "2026-07-11T00:00:00Z",
};

const resources: PodResourceConfig = {
  podId: "pod-a",
  overrides: {
    memLimit: "",
    cpuLimit: "2",
    restartPolicy: "",
    maxSkillConcurrency: 3,
    maxBrowserConcurrency: 2,
  },
  globalDefaults: {
    memLimit: "2g",
    cpuLimit: "",
    restartPolicy: "unless-stopped",
    maxSkillConcurrency: 0,
    maxBrowserConcurrency: 0,
  },
  runtimeDefaults: {
    memLimit: "1g",
    cpuLimit: "1",
    restartPolicy: "unless-stopped",
    maxSkillConcurrency: 1,
    maxBrowserConcurrency: 1,
  },
  effective: {
    memLimit: "2g",
    cpuLimit: "2",
    restartPolicy: "unless-stopped",
    maxSkillConcurrency: 3,
    maxBrowserConcurrency: 2,
  },
  memoryAlertThresholdMiB: 1740,
  configGeneration: 3,
  appliedGeneration: 2,
  lastApplyStatus: "failed",
};

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.getPod.mockResolvedValue(pod);
  apiMocks.getPodResources.mockResolvedValue(resources);
  apiMocks.listHumanUsers.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  apiMocks.action.mockResolvedValue({ podId: "pod-a", state: "running" });
  apiMocks.applyPodConfig.mockResolvedValue({
    podId: "pod-a",
    status: "queued",
    configGeneration: 3,
    appliedGeneration: 2,
  });
  apiMocks.deletePod.mockResolvedValue({ podId: "pod-a", deleted: true, stateRetained: false });
});

afterEach(() => Toast.destroyAll());

describe("PodDetail", () => {
  it("shows user, channel, configuration, and resource tabs", async () => {
    render(<PodDetail podId="pod-a" onBack={vi.fn()} onDeleted={vi.fn()} />);
    expect(await screen.findByText("Pod A")).toBeInTheDocument();
    expect(screen.getByText("已分配用户")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "通道" }));
    expect(screen.getByText(/企业微信/)).toBeInTheDocument();
    expect(screen.getByText("离线")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "配置" }));
    expect(screen.getByText(/期望 generation/)).toBeInTheDocument();
    expect(screen.getByText("未收敛（lag 1）")).toBeInTheDocument();
    expect(screen.getByText("runtime rejected generation")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "资源与并发" }));
    expect(screen.getByText(/Skill 并发/)).toBeInTheDocument();
    expect(screen.getByText("3（覆盖 3）")).toBeInTheDocument();
  });

  it("refreshes generation state and retries configuration apply", async () => {
    const converged = {
      ...pod,
      appliedGeneration: 3,
      generationLag: 0,
      lastApplyStatus: "applied" as const,
      lastApplyError: undefined,
      runtimeGuardHealthy: true,
    };
    apiMocks.getPod.mockResolvedValueOnce(pod).mockResolvedValue(converged);
    render(<PodDetail podId="pod-a" onBack={vi.fn()} onDeleted={vi.fn()} />);
    await screen.findByText("Pod A");

    fireEvent.click(screen.getByRole("button", { name: "重试应用" }));
    await waitFor(() => expect(apiMocks.applyPodConfig).toHaveBeenCalledWith("pod-a"));

    fireEvent.click(screen.getByRole("tab", { name: "配置" }));
    expect(await screen.findByText("已收敛")).toBeInTheDocument();
    expect(screen.getAllByText("3")).toHaveLength(2);
  });

  it("shows operation errors without leaving the detail view", async () => {
    apiMocks.action.mockRejectedValue(new Error("restart failed"));
    render(<PodDetail podId="pod-a" onBack={vi.fn()} onDeleted={vi.fn()} />);
    await screen.findByText("Pod A");

    fireEvent.click(screen.getByRole("button", { name: "重启" }));

    expect(await screen.findByText("restart failed")).toBeInTheDocument();
    expect(screen.getByText("Pod A")).toBeInTheDocument();
  });

  it("requires an explicit PVC choice for destructive deletion", async () => {
    const onDeleted = vi.fn();
    render(<PodDetail podId="pod-a" onBack={vi.fn()} onDeleted={onDeleted} />);
    await screen.findByText("Pod A");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    expect(screen.getByText(/workspace、记忆、会话和 private Skill/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /删除 PVC/ }));
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() => expect(apiMocks.deletePod).toHaveBeenCalledWith("pod-a", true));
    expect(onDeleted).toHaveBeenCalledOnce();
  });
});
