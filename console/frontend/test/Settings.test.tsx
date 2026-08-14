import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api";
import { Settings } from "../src/pages/Settings";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const apiMocks = vi.hoisted(() => ({
  getResources: vi.fn(),
  setResources: vi.fn(),
  getAgentGuidance: vi.fn(),
  setAgentGuidance: vi.fn(),
  listPlatforms: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

const resources = {
  configured: true,
  memLimit: "4g",
  cpuLimit: "2",
  restartPolicy: "unless-stopped",
  globalOverrides: {
    memLimit: "4g",
    cpuLimit: "2",
    restartPolicy: "unless-stopped",
    maxSkillConcurrency: 0,
    maxBrowserConcurrency: 0,
    maxLongTaskConcurrency: 0,
  },
  runtimeDefaults: {
    memLimit: "2g",
    cpuLimit: "1.5",
    restartPolicy: "unless-stopped",
    maxSkillConcurrency: 2,
    maxBrowserConcurrency: 1,
    maxLongTaskConcurrency: 2,
  },
  effective: {
    memLimit: "4g",
    cpuLimit: "2",
    restartPolicy: "unless-stopped",
    maxSkillConcurrency: 2,
    maxBrowserConcurrency: 1,
    maxLongTaskConcurrency: 2,
  },
};

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.getResources.mockResolvedValue(resources);
  apiMocks.setResources.mockResolvedValue({ configured: true, affectedPodIds: ["pod-a"] });
  apiMocks.getAgentGuidance.mockResolvedValue({
    userSkill: "",
    memory: "",
    main: "",
    updatedAt: "",
  });
  apiMocks.setAgentGuidance.mockResolvedValue({
    userSkill: "",
    memory: "",
    main: "",
    updatedAt: "",
  });
  apiMocks.listPlatforms.mockResolvedValue({ items: [], total: 0 });
});

describe("Settings", () => {
  it("shows effective Pod limits and runtime concurrency defaults", async () => {
    render(<Settings />);

    expect(await screen.findByDisplayValue("4")).toBeInTheDocument();
    // 标签同时出现在默认值表单与生效指标两块（各自含义不同，均为合法出现）
    expect(screen.getAllByText("Skill 并发默认值").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Browser 并发默认值").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
  });

  it("saves global defaults and reports affected Pods", async () => {
    render(<Settings />);
    const memory = await screen.findByLabelText("全局 Pod 内存上限");
    fireEvent.change(memory, { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资源默认值" }));

    await waitFor(() =>
      expect(apiMocks.setResources).toHaveBeenCalledWith({
        memLimit: "6",
        cpuLimit: "2",
        restartPolicy: "unless-stopped",
        maxSkillConcurrency: 2,
        maxBrowserConcurrency: 1,
        maxLongTaskConcurrency: 2,
      }),
    );
    expect(await screen.findByText(/1 个 Pod 等待应用/)).toBeInTheDocument();
  });

  it("shows resource validation details returned by the backend", async () => {
    apiMocks.setResources.mockRejectedValueOnce(
      new ApiError("资源配额配置不合法", 400, 40003, "maxBrowserConcurrency 必须为 0 或 1-1000"),
    );
    render(<Settings />);
    await screen.findByLabelText("全局 Pod 内存上限");

    fireEvent.click(screen.getByRole("button", { name: "保存资源默认值" }));

    expect(await screen.findByText("技术详情")).toBeInTheDocument();
    expect(screen.getByText(/maxBrowserConcurrency/)).toBeInTheDocument();
  });

  it("saves agent workspace guidance", async () => {
    render(<Settings />);
    const area = await screen.findByLabelText("用户自建 Skill 规则");
    fireEvent.change(area, { target: { value: "- 自定义语言规则" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Agent 工作区指导" }));
    await waitFor(() =>
      expect(apiMocks.setAgentGuidance).toHaveBeenCalledWith(
        expect.objectContaining({ userSkill: "- 自定义语言规则" }),
      ),
    );
  });
});
