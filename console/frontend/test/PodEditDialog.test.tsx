import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pod, PodResourceConfig } from "../src/api";
import { ApiError } from "../src/api";
import { PodEditDialog } from "../src/pages/containers/PodEditDialog";

const apiMocks = vi.hoisted(() => ({
  getPod: vi.fn(),
  getPodResources: vi.fn(),
  updatePodChannels: vi.fn(),
  setPodResources: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getPod: apiMocks.getPod,
      getPodResources: apiMocks.getPodResources,
      updatePodChannels: apiMocks.updatePodChannels,
      setPodResources: apiMocks.setPodResources,
    },
  };
});

const pod: Pod = {
  podId: "pod-a",
  displayName: "Pod A",
  imageTag: "muad-openclaw:test",
  state: "running",
  channels: ["wecom"],
  channelConfigs: { wecom: { botId: "wb-existing", secretConfigured: true } },
  channelStatuses: { wecom: true },
  maxUsers: 10,
  userCount: 1,
  availableSlots: 9,
  configGeneration: 2,
  appliedGeneration: 1,
  generationLag: 1,
  skillsPending: false,
  lastApplyStatus: "applied",
  serviceTokenFingerprint: "sha256:test",
  cpuPercent: 0,
  cpuMills: 0,
  cpuLimitCores: "0",
  memMiB: 256,
  memLimitMiB: 0,
  skillActive: 0,
  skillQueued: 0,
  browserActive: 0,
  browserQueued: 0,
  runtimeGuardHealthy: true,
  createdAt: "2026-07-11T00:00:00Z",
  updatedAt: "2026-07-11T00:00:00Z",
};

const resources: PodResourceConfig = {
  podId: "pod-a",
  overrides: { memLimit: "4g", cpuLimit: "2", restartPolicy: "", maxSkillConcurrency: 0, maxBrowserConcurrency: 0, maxLongTaskConcurrency: 0 },
  globalDefaults: { memLimit: "2g", cpuLimit: "1", restartPolicy: "unless-stopped", maxSkillConcurrency: 1, maxBrowserConcurrency: 1, maxLongTaskConcurrency: 2 },
  runtimeDefaults: { memLimit: "1g", cpuLimit: "1", restartPolicy: "unless-stopped", maxSkillConcurrency: 1, maxBrowserConcurrency: 1, maxLongTaskConcurrency: 2 },
  effective: { memLimit: "4g", cpuLimit: "2", restartPolicy: "", maxSkillConcurrency: 1, maxBrowserConcurrency: 1, maxLongTaskConcurrency: 2 },
  memoryAlertThresholdMiB: 0,
  configGeneration: 1,
  appliedGeneration: 1,
  lastApplyStatus: "applied",
};

beforeEach(() => {
  apiMocks.getPod.mockReset();
  apiMocks.getPodResources.mockReset();
  apiMocks.updatePodChannels.mockReset();
  apiMocks.setPodResources.mockReset();
  apiMocks.getPod.mockResolvedValue(pod);
  apiMocks.getPodResources.mockResolvedValue(resources);
});

describe("PodEditDialog", () => {
  it("合并展示消息通道与资源两个区块", async () => {
    render(<PodEditDialog podId="pod-a" onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByText("编辑 pod-a")).toBeInTheDocument();
    // 等表单内容渲染（加载完成后才出现），避免在加载阶段断言
    expect(await screen.findByText("消息通道")).toBeInTheDocument();
    expect(screen.getByText("资源")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
    // 资源覆盖预填（4g → 4）
    expect(screen.getByDisplayValue("4")).toBeInTheDocument();
  });

  it("单次保存：先提交通道，再提交资源", { timeout: 10000 }, async () => {
    render(<PodEditDialog podId="pod-a" onClose={vi.fn()} onSaved={vi.fn()} />);
    // 等表单内容渲染，确保编辑模式的凭据已从 initial seed（依赖校验通过）
    await screen.findByText("消息通道");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    // 两个提交是串行 await（通道 → 资源），waitFor 内同时断言两个 mock，
    // 避免通道调用出现后、资源调用的微任务续延尚未执行时的竞态。
    // 超时放宽到 5s：cf-stop / CI 并发跑多套测试时事件循环可能饥饿，默认 1s 会误报 flake。
    // 测试级 testTimeout 同步放宽到 10s：waitFor 用满 5s 时叠加 findByText 与渲染耗时，
    // 会超出 vitest 默认 5s testTimeout，被误判为 long-running test。
    await waitFor(
      () => {
        expect(apiMocks.updatePodChannels).toHaveBeenCalledTimes(1);
        expect(apiMocks.setPodResources).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );
    expect(apiMocks.setPodResources).toHaveBeenCalledWith("pod-a", {
      memLimit: "4",
      cpuLimit: "2",
      restartPolicy: "",
      maxSkillConcurrency: 0,
      maxBrowserConcurrency: 0,
      maxLongTaskConcurrency: 0,
    });
    expect(apiMocks.updatePodChannels.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.setPodResources.mock.invocationCallOrder[0],
    );
  });

  it("未选择任何通道时拦截保存，不调用接口", async () => {
    apiMocks.getPod.mockResolvedValue({
      ...pod,
      channels: [],
      channelConfigs: {},
    });
    render(<PodEditDialog podId="pod-a" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByText("消息通道");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/至少选择一个通道/)).toBeInTheDocument();
    expect(apiMocks.updatePodChannels).not.toHaveBeenCalled();
    expect(apiMocks.setPodResources).not.toHaveBeenCalled();
  });

  it("加载失败时展示错误且不渲染表单", async () => {
    apiMocks.getPodResources.mockRejectedValue(new Error("boom"));
    render(<PodEditDialog podId="pod-a" onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByText(/加载通道配置失败/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("保存失败时展示后端字段详情", async () => {
    apiMocks.setPodResources.mockRejectedValueOnce(
      new ApiError("资源配额配置不合法", 400, 40003, "cpuLimit 必须为空或正数"),
    );
    render(<PodEditDialog podId="pod-a" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByText("消息通道");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("资源配额配置不合法")).toBeInTheDocument();
    expect(screen.getByText("技术详情")).toBeInTheDocument();
    expect(screen.getByText(/cpuLimit 必须/)).toBeInTheDocument();
  });
});
