import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pod } from "../src/api";
import { Containers } from "../src/pages/Containers";

const apiMocks = vi.hoisted(() => ({
  listPods: vi.fn(),
  createPod: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listPods: apiMocks.listPods,
      createPod: apiMocks.createPod,
    },
  };
});

const pod: Pod = {
  podId: "pod-a",
  displayName: "Pod A",
  imageTag: "muad-openclaw:test",
  state: "running",
  channels: ["wecom"],
  channelStatuses: { wecom: true },
  maxUsers: 10,
  userCount: 1,
  availableSlots: 9,
  configGeneration: 2,
  appliedGeneration: 1,
  generationLag: 1,
  lastApplyStatus: "pending",
  serviceTokenFingerprint: "sha256:test",
  cpuPercent: 1.2,
  memMiB: 256,
  skillActive: 0,
  skillQueued: 0,
  browserActive: 0,
  browserQueued: 0,
  runtimeGuardHealthy: true,
  createdAt: "2026-07-11T00:00:00Z",
  updatedAt: "2026-07-11T00:00:00Z",
};

beforeEach(() => {
  apiMocks.listPods.mockReset();
  apiMocks.createPod.mockReset();
  apiMocks.listPods.mockResolvedValue({ items: [pod], total: 25, page: 1, pageSize: 20 });
});

describe("Containers Pod list", () => {
  it("renders capacity and configuration generation from the Pod response", async () => {
    render(<Containers />);

    expect(await screen.findByText("Pod A")).toBeInTheDocument();
    expect(screen.getByText("1/10")).toBeInTheDocument();
    expect(screen.getByText("剩余 9")).toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: /待应用 1\/2/ })).toBeInTheDocument();
    expect(screen.getByText("待应用")).toBeInTheDocument();
  });

  it("sends search and pagination to the backend", async () => {
    render(<Containers />);
    await screen.findByText("Pod A");

    fireEvent.change(screen.getByPlaceholderText("Pod ID 或名称"), {
      target: { value: "production" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询 Pod" }));

    await waitFor(() =>
      expect(apiMocks.listPods).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 10,
        q: "production",
        state: undefined,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(apiMocks.listPods).toHaveBeenLastCalledWith({
        page: 2,
        pageSize: 10,
        q: "production",
        state: undefined,
      }),
    );
  });
});

describe("Containers create Pod flow", () => {
  function openCreateModal() {
    fireEvent.click(screen.getByRole("button", { name: "创建 Pod" }));
  }

  function fillMinimalCreateForm() {
    fireEvent.change(screen.getByPlaceholderText("muad-pod-01"), {
      target: { value: "pod-new" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "💬 微信" }));
  }

  it("validates the Pod ID before sending", async () => {
    render(<Containers />);
    await screen.findByText("Pod A");
    openCreateModal();
    fireEvent.click(screen.getByRole("checkbox", { name: "💬 微信" }));

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText("Pod ID 必填")).toBeInTheDocument();
    expect(apiMocks.createPod).not.toHaveBeenCalled();
  });

  it("rejects non-numeric memory limits before sending", async () => {
    render(<Containers />);
    await screen.findByText("Pod A");
    openCreateModal();
    fillMinimalCreateForm();
    fireEvent.change(screen.getByPlaceholderText("留空继承，如 16"), {
      target: { value: "abc" },
    });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText("内存上限请填写数字（单位 GiB），例如 16")).toBeInTheDocument();
    expect(apiMocks.createPod).not.toHaveBeenCalled();
  });

  it("accepts a bare numeric memory limit (GiB)", async () => {
    apiMocks.createPod.mockResolvedValue({ ...pod, podId: "pod-new" });
    render(<Containers />);
    await screen.findByText("Pod A");
    openCreateModal();
    fillMinimalCreateForm();
    fireEvent.change(screen.getByPlaceholderText("留空继承，如 16"), {
      target: { value: "16" },
    });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(apiMocks.createPod).toHaveBeenCalled());
  });

  it("creates a Pod with capacity, resource, concurrency, and channel fields", async () => {
    apiMocks.createPod.mockResolvedValue({ ...pod, podId: "pod-new", displayName: "pod-new" });
    render(<Containers />);
    await screen.findByText("Pod A");
    openCreateModal();
    fillMinimalCreateForm();

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(apiMocks.createPod).toHaveBeenCalledWith(
        expect.objectContaining({
          podId: "pod-new",
          displayName: "pod-new",
          maxUsers: 10,
          channels: ["wechat"],
          channelConfigs: { wechat: {} },
          maxSkillConcurrency: 0,
          maxBrowserConcurrency: 0,
        }),
      ),
    );
    await waitFor(() => expect(apiMocks.listPods).toHaveBeenCalledTimes(2));
  });

  it("keeps the modal open and shows backend create errors", async () => {
    apiMocks.createPod.mockRejectedValue(new Error("Pod already exists"));
    render(<Containers />);
    await screen.findByText("Pod A");
    openCreateModal();
    fillMinimalCreateForm();

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText("创建 Pod 失败")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("muad-pod-01")).toBeInTheDocument();
  });

  it("can select 接管同名保留状态卷 and sends adoptState=true", async () => {
    apiMocks.createPod.mockResolvedValue({ ...pod, podId: "pod-new", displayName: "pod-new" });
    render(<Containers />);
    await screen.findByText("Pod A");
    openCreateModal();
    fillMinimalCreateForm();

    const adopt = screen.getByRole("checkbox", { name: /接管同名保留状态卷/ });
    // 回归守卫：Semi Checkbox 不能被 <label> 包裹——浏览器 label 激活会对内部控制元素
    // 再派发一次合成 click，导致 onChange 触发两次、勾选被立刻抵消（真实浏览器必现）。
    expect(adopt.closest("label")).toBeNull();
    fireEvent.click(adopt);
    expect(adopt).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(apiMocks.createPod).toHaveBeenCalledWith(
        expect.objectContaining({ podId: "pod-new", adoptState: true }),
      ),
    );
  });

  it("restore users requires adopting state and is forced off otherwise", async () => {
    apiMocks.createPod.mockResolvedValue({ ...pod, podId: "pod-new", displayName: "pod-new" });
    render(<Containers />);
    await screen.findByText("Pod A");
    openCreateModal();
    fillMinimalCreateForm();

    const restore = screen.getByRole("checkbox", { name: /恢复原 Pod 用户/ });
    // Without adopting the retained state volume, restoring users is disabled.
    expect(restore).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(apiMocks.createPod).toHaveBeenCalledWith(
        expect.objectContaining({ adoptState: false, restoreUsers: false }),
      ),
    );
  });
});
