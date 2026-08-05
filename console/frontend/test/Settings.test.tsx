import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  },
  runtimeDefaults: {
    memLimit: "2g",
    cpuLimit: "1.5",
    restartPolicy: "unless-stopped",
    maxSkillConcurrency: 2,
    maxBrowserConcurrency: 1,
  },
  effective: {
    memLimit: "4g",
    cpuLimit: "2",
    restartPolicy: "unless-stopped",
    maxSkillConcurrency: 2,
    maxBrowserConcurrency: 1,
  },
};

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.getResources.mockResolvedValue(resources);
  apiMocks.setResources.mockResolvedValue({ configured: true, affectedPodIds: ["pod-a"] });
  apiMocks.getAgentGuidance.mockResolvedValue({ userSkill: "", memory: "", main: "", updatedAt: "" });
  apiMocks.setAgentGuidance.mockResolvedValue({ userSkill: "", memory: "", main: "", updatedAt: "" });
  apiMocks.listPlatforms.mockResolvedValue({ items: [], total: 0 });
});

describe("Settings", () => {
  it("shows effective Pod limits and runtime concurrency defaults", async () => {
    render(<Settings />);

    expect(await screen.findByDisplayValue("4g")).toBeInTheDocument();
    expect(screen.getByText("Skill 并发默认值")).toBeInTheDocument();
    expect(screen.getByText("Browser 并发默认值")).toBeInTheDocument();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
  });

  it("saves global defaults and reports affected Pods", async () => {
    render(<Settings />);
    const memory = await screen.findByLabelText("全局 Pod 内存上限");
    fireEvent.change(memory, { target: { value: "6g" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资源默认值" }));

    await waitFor(() =>
      expect(apiMocks.setResources).toHaveBeenCalledWith({
        memLimit: "6g",
        cpuLimit: "2",
        restartPolicy: "unless-stopped",
      }),
    );
    expect(await screen.findByText(/1 个 Pod 等待应用/)).toBeInTheDocument();
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
