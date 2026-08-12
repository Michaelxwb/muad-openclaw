import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../src/api";
import { Audit } from "../src/pages/Audit";

const auditMock = vi.hoisted(() => vi.fn());
const listSkillExecutionsMock = vi.hoisted(() => vi.fn());
const listAllHumanUsersMock = vi.hoisted(() => vi.fn());
const listPodsMock = vi.hoisted(() => vi.fn());

function selectFollowingOption(combobox: HTMLElement, steps: number) {
  fireEvent.click(combobox);
  for (let step = 0; step < steps; step += 1) {
    fireEvent.keyDown(combobox, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
  }
  fireEvent.keyDown(combobox, { key: "Enter", code: "Enter", keyCode: 13 });
}

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      audit: auditMock,
      listSkillExecutions: listSkillExecutionsMock,
      listAllHumanUsers: listAllHumanUsersMock,
      listPods: listPodsMock,
    },
  };
});

const entry: AuditEntry = {
  id: 1,
  actor: "admin:root",
  action: "identity.create",
  target: "identity-a",
  targetType: "identity",
  payload: '{"status":"active"}',
  metadata: {
    podId: "pod-a",
    humanUserId: "user-a",
    identityId: "identity-a",
    status: "active",
  },
  ts: "2026-07-11T00:00:00Z",
};

const execution = {
  executionId: "run-a",
  podId: "pod-a",
  humanUserId: "user-a",
  agentId: "agent-a",
  skillName: "mss-report-skill",
  skillScope: "private" as const,
  startedAt: "2026-07-14T10:00:00Z",
  createdAt: "2026-07-14T10:00:00Z",
};

beforeEach(() => {
  window.history.replaceState(null, "", "/audit?tab=operations");
  auditMock.mockReset();
  auditMock.mockResolvedValue({ items: [entry], total: 1 });
  listSkillExecutionsMock.mockReset();
  listSkillExecutionsMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
  listAllHumanUsersMock.mockReset();
  listAllHumanUsersMock.mockResolvedValue({
    items: [{ humanUserId: "user-a", displayName: "张三" }],
    total: 1,
    page: 1,
    pageSize: 1000,
  });
  listPodsMock.mockReset();
  listPodsMock.mockResolvedValue({
    items: [{ podId: "pod-a", displayName: "主节点" }],
    total: 1,
    page: 1,
    pageSize: 10,
  });
});

describe("Audit", () => {
  it("shows semantic actor, target type, and scoped context", async () => {
    render(<Audit />);

    expect(await screen.findByText("admin:root")).toBeInTheDocument();
    expect(screen.getByText("identity.create")).toBeInTheDocument();
    expect(screen.getByText("Identity")).toBeInTheDocument();
    expect(screen.getByText(/pod=pod-a/)).toBeInTheDocument();
    expect(screen.getByText(/user=user-a/)).toBeInTheDocument();
  });

  it("submits actor, action, and target filters through the typed API", async () => {
    render(<Audit />);
    await screen.findByText("admin:root");
    fireEvent.change(screen.getByLabelText("按操作人过滤"), { target: { value: "pod:pod-a" } });
    fireEvent.change(screen.getByLabelText("按动作过滤"), { target: { value: "runtime_guard" } });
    fireEvent.change(screen.getByLabelText("按目标过滤"), { target: { value: "pod-a" } });
    fireEvent.click(screen.getByRole("button", { name: "查询审计日志" }));

    await waitFor(() =>
      expect(auditMock).toHaveBeenLastCalledWith({
        actor: "pod:pod-a",
        action: "runtime_guard",
        target: "pod-a",
        offset: 0,
        limit: 10,
      }),
    );
  });

  it("keeps audit filters compact in the list toolbar", async () => {
    render(<Audit />);
    await screen.findByText("admin:root");

    expect(screen.getByLabelText("按操作人过滤").parentElement).toHaveStyle({ width: "160px" });
    expect(screen.getByLabelText("按动作过滤").parentElement).toHaveStyle({ width: "180px" });
    expect(screen.getByLabelText("按目标过滤").parentElement).toHaveStyle({ width: "160px" });
  });

  it("restores the Skill execution tab from the URL without loading operation audit", async () => {
    window.history.replaceState(null, "", "/audit?tab=skill-executions");

    render(<Audit />);

    expect(screen.getByRole("tab", { name: "Skill 执行日志" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() => expect(listSkillExecutionsMock).toHaveBeenCalledTimes(1));
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("keeps each tab state isolated and persists the active tab in the URL", async () => {
    render(<Audit />);
    await screen.findByText("admin:root");
    fireEvent.change(screen.getByLabelText("按操作人过滤"), {
      target: { value: "admin:alice" },
    });

    fireEvent.click(screen.getByRole("tab", { name: "Skill 执行日志" }));
    await waitFor(() => expect(listSkillExecutionsMock).toHaveBeenCalledTimes(1));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("skill-executions");

    fireEvent.click(screen.getByRole("tab", { name: "操作审计" }));
    expect(screen.getByLabelText("按操作人过滤")).toHaveValue("admin:alice");
    await waitFor(() => expect(auditMock).toHaveBeenCalledTimes(2));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("operations");
  });

  it("falls back to operation audit for an invalid tab parameter", async () => {
    window.history.replaceState(null, "", "/audit?tab=invalid");

    render(<Audit />);

    expect(await screen.findByText("admin:root")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "操作审计" })).toHaveAttribute("aria-selected", "true");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("operations");
    expect(listSkillExecutionsMock).not.toHaveBeenCalled();
  });

  it("fuzzy-searches Skill executions across identity fields and filters by scope", async () => {
    window.history.replaceState(null, "", "/audit?tab=skill-executions");
    listSkillExecutionsMock.mockResolvedValue({
      items: [execution],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    render(<Audit />);
    expect(await screen.findByText("mss-report-skill")).toBeInTheDocument();
    expect(await screen.findByText("张三")).toBeInTheDocument();
    expect(screen.getByText("agent-a")).toBeInTheDocument();
    expect(screen.getByText("主节点")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("模糊搜索执行日志"), {
      target: { value: "report" },
    });
    selectFollowingOption(screen.getByRole("combobox", { name: "Skill 范围" }), 3);
    fireEvent.click(screen.getByRole("button", { name: "查询执行日志" }));

    await waitFor(() =>
      expect(listSkillExecutionsMock).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 10,
        q: "report",
        scope: "private",
      }),
    );
    expect(screen.getByText("mss-report-skill")).toBeInTheDocument();
  });

  it("filters Skill executions by fuzzy query and local start-time range", async () => {
    window.history.replaceState(null, "", "/audit?tab=skill-executions");
    render(<Audit />);
    await waitFor(() => expect(listSkillExecutionsMock).toHaveBeenCalledTimes(1));

    const startedFrom = "2026-07-14T09:00";
    const startedTo = "2026-07-14T11:30";
    fireEvent.change(screen.getByLabelText("模糊搜索执行日志"), {
      target: { value: "user-a" },
    });
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: startedFrom },
    });
    fireEvent.change(screen.getByLabelText("结束时间"), {
      target: { value: startedTo },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询执行日志" }));

    await waitFor(() =>
      expect(listSkillExecutionsMock).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 10,
        q: "user-a",
        startedFrom: new Date(startedFrom).toISOString(),
        startedTo: new Date(startedTo).toISOString(),
      }),
    );
  });

  it("renders an icon-only search button beside the query input", async () => {
    window.history.replaceState(null, "", "/audit?tab=skill-executions");
    render(<Audit />);
    await waitFor(() => expect(listSkillExecutionsMock).toHaveBeenCalledTimes(1));

    const searchButton = screen.getByRole("button", { name: "查询执行日志" });
    expect(searchButton).not.toHaveTextContent("搜索");
  });

  it("auto-applies the scope filter without pressing search", async () => {
    window.history.replaceState(null, "", "/audit?tab=skill-executions");
    render(<Audit />);
    await waitFor(() => expect(listSkillExecutionsMock).toHaveBeenCalledTimes(1));

    selectFollowingOption(screen.getByRole("combobox", { name: "Skill 范围" }), 3);

    await waitFor(() =>
      expect(listSkillExecutionsMock).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 10,
        scope: "private",
      }),
    );
  });

  it("auto-applies the start-time filter without pressing search", async () => {
    window.history.replaceState(null, "", "/audit?tab=skill-executions");
    render(<Audit />);
    await waitFor(() => expect(listSkillExecutionsMock).toHaveBeenCalledTimes(1));

    const startedFrom = "2026-07-14T09:00";
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: startedFrom },
    });

    await waitFor(() =>
      expect(listSkillExecutionsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 1,
          pageSize: 10,
          startedFrom: new Date(startedFrom).toISOString(),
        }),
      ),
    );
  });

  it("uses the shared page-size control and resets to the first page", async () => {
    window.history.replaceState(null, "", "/audit?tab=skill-executions");
    listSkillExecutionsMock.mockResolvedValue({
      items: [execution],
      total: 12,
      page: 1,
      pageSize: 10,
    });
    render(<Audit />);
    expect(await screen.findByText("1/2")).toBeInTheDocument();

    selectFollowingOption(screen.getByRole("combobox", { name: "每页数量" }), 1);

    await waitFor(() =>
      expect(listSkillExecutionsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, pageSize: 20 }),
      ),
    );
  });

  it("keeps filters visible and retries after a list error", async () => {
    window.history.replaceState(null, "", "/audit?tab=skill-executions");
    listSkillExecutionsMock
      .mockRejectedValueOnce(new Error("执行日志暂时不可用"))
      .mockResolvedValueOnce({ items: [execution], total: 1, page: 1, pageSize: 10 });
    render(<Audit />);

    expect(await screen.findByText("加载 Skill 执行日志失败")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("模糊搜索执行日志"), {
      target: { value: "report" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重新查询" }));

    expect(await screen.findByText("mss-report-skill")).toBeInTheDocument();
    expect(screen.getByLabelText("模糊搜索执行日志")).toHaveValue("report");
  });
});
