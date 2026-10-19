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
  getNotifySettings: vi.fn(),
  setNotifySettings: vi.fn(),
  testNotifySettings: vi.fn(),
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
  skillRequestLimit: 0,
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
    globalPrompt: "",
    userSkill: "",
    memory: "",
    main: "",
    updatedAt: "",
  });
  apiMocks.setAgentGuidance.mockResolvedValue({
    globalPrompt: "",
    userSkill: "",
    memory: "",
    main: "",
    updatedAt: "",
  });
  apiMocks.getNotifySettings.mockResolvedValue({ enabled: false, webhook: "", updatedAt: "" });
  apiMocks.setNotifySettings.mockResolvedValue({
    enabled: false,
    webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd****wxyz",
    updatedAt: "2026-10-17T00:00:00Z",
  });
  apiMocks.testNotifySettings.mockResolvedValue({ ok: true, errcode: 0, errmsg: "ok" });
  apiMocks.listPlatforms.mockResolvedValue({ items: [], total: 0 });
});

describe("Settings", () => {
  it("shows configured resource defaults in the form", async () => {
    render(<Settings />);

    expect(await screen.findByDisplayValue("4")).toBeInTheDocument();
    expect(screen.getAllByText("Skill 并发默认值").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Browser 并发默认值").length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue("2").length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue("1").length).toBeGreaterThan(0);
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
        skillRequestLimit: 0,
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
    const globalArea = await screen.findByLabelText("全局 Agent Prompt");
    fireEvent.change(globalArea, { target: { value: "- 全局规则" } });
    const area = screen.getByLabelText("用户自建 Skill 规则");
    fireEvent.change(area, { target: { value: "- 自定义语言规则" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Agent 工作区指导" }));
    await waitFor(() =>
      expect(apiMocks.setAgentGuidance).toHaveBeenCalledWith(
        expect.objectContaining({
          globalPrompt: "- 全局规则",
          userSkill: "- 自定义语言规则",
          memory: "",
          main: "",
        }),
      ),
    );
  });

  it("shows the unlimited hint and saves a zero request limit", async () => {
    render(<Settings />);
    await screen.findByLabelText("全局 Pod 内存上限");

    expect(await screen.findByText("不限制")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存资源默认值" }));
    await waitFor(() =>
      expect(apiMocks.setResources).toHaveBeenCalledWith(
        expect.objectContaining({ skillRequestLimit: 0 }),
      ),
    );
  });

  it("rejects negative and non-integer request limits without sending", async () => {
    render(<Settings />);
    const limit = await screen.findByLabelText("Skill 单次请求上限");

    fireEvent.change(limit, { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资源默认值" }));
    expect(await screen.findByText("请求上限必须为 0-1000000 之间的整数")).toBeInTheDocument();
    expect(apiMocks.setResources).not.toHaveBeenCalled();

    fireEvent.change(limit, { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资源默认值" }));
    expect(await screen.findByText("请求上限必须为整数")).toBeInTheDocument();
    expect(apiMocks.setResources).not.toHaveBeenCalled();
  });

  it("shows the masked webhook, keeps the input empty, and saves without overwriting", async () => {
    apiMocks.getNotifySettings.mockResolvedValue({
      enabled: true,
      webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd****wxyz",
      updatedAt: "2026-10-17T00:00:00Z",
    });
    apiMocks.setNotifySettings.mockResolvedValue({
      enabled: true,
      webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd****wxyz",
      updatedAt: "2026-10-17T00:00:00Z",
    });
    render(<Settings />);

    expect(await screen.findByText(/key=abcd\*{4}wxyz/)).toBeInTheDocument();
    const input = screen.getByLabelText("告警 Webhook 地址") as HTMLInputElement;
    expect(input.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "保存告警设置" }));
    await waitFor(() => expect(apiMocks.setNotifySettings).toHaveBeenCalledWith({ enabled: true }));
    expect(await screen.findByText("告警设置已保存")).toBeInTheDocument();

    fireEvent.change(input, {
      target: { value: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存告警设置" }));
    await waitFor(() =>
      expect(apiMocks.setNotifySettings).toHaveBeenLastCalledWith({
        enabled: true,
        webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new-secret",
      }),
    );
  });

  it("shows the test failure reason inline and keeps the typed webhook", async () => {
    apiMocks.testNotifySettings.mockResolvedValue({
      ok: false,
      errcode: 93000,
      errmsg: "invalid webhook url",
    });
    render(<Settings />);

    const input = await screen.findByLabelText("告警 Webhook 地址");
    fireEvent.change(input, { target: { value: "https://example.test/hook" } });
    fireEvent.click(screen.getByRole("button", { name: "测试告警通道" }));

    expect(await screen.findByText(/93000/)).toBeInTheDocument();
    expect(screen.getByText(/invalid webhook url/)).toBeInTheDocument();
    expect(input).toHaveValue("https://example.test/hook");
  });

  it("shows notify save errors from the backend inline", async () => {
    apiMocks.setNotifySettings.mockRejectedValueOnce(
      new ApiError("启用告警前必须配置 Webhook", 400, 40012, "webhook required"),
    );
    render(<Settings />);

    fireEvent.click(await screen.findByRole("button", { name: "保存告警设置" }));

    expect(await screen.findByText("启用告警前必须配置 Webhook")).toBeInTheDocument();
    expect(screen.getByText("技术详情")).toBeInTheDocument();
  });
});
