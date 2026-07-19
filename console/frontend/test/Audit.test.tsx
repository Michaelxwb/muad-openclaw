import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../src/api";
import { Audit } from "../src/pages/Audit";

const auditMock = vi.hoisted(() => vi.fn());
const listSkillExecutionsMock = vi.hoisted(() => vi.fn());
const getSkillExecutionMock = vi.hoisted(() => vi.fn());

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
      getSkillExecution: getSkillExecutionMock,
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
  skillVersion: "sha256:abc",
  entryType: "traditional-script" as const,
  activationMode: "runner" as const,
  eventSeq: 3,
  status: "failed" as const,
  startedAt: "2026-07-14T10:00:00Z",
  endedAt: "2026-07-14T10:00:02Z",
  durationMs: 2000,
  lastToolName: "muad_run_skill",
  terminalReason: "tool-error",
  errorCode: "report_failed",
  errorMessage: "生成报告失败",
  inputSummary: "导出测试客户周报",
  outputSummary: "",
  createdAt: "2026-07-14T10:00:00Z",
};

beforeEach(() => {
  window.history.replaceState(null, "", "/audit?tab=operations");
  auditMock.mockReset();
  auditMock.mockResolvedValue({ items: [entry], total: 1 });
  listSkillExecutionsMock.mockReset();
  listSkillExecutionsMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
  getSkillExecutionMock.mockReset();
  getSkillExecutionMock.mockResolvedValue({
    ...execution,
    progressJson:
      '[{"type":"tool","stage":"report","text":"正在生成周报","ts":"2026-07-14T10:00:01Z"}]',
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

  it("fuzzy-searches Skill executions across identity fields and filters by status", async () => {
    window.history.replaceState(null, "", "/audit?tab=skill-executions");
    listSkillExecutionsMock.mockResolvedValue({
      items: [execution],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    render(<Audit />);
    expect(await screen.findByText("mss-report-skill")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("模糊搜索执行日志"), {
      target: { value: "report" },
    });
    selectFollowingOption(screen.getByRole("combobox", { name: "执行状态" }), 3);
    fireEvent.click(screen.getByRole("button", { name: "查询执行日志" }));

    await waitFor(() =>
      expect(listSkillExecutionsMock).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 10,
        q: "report",
        status: "failed",
      }),
    );
    expect(screen.getByText("生成报告失败")).toBeInTheDocument();
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

    expect(await screen.findByText("执行日志暂时不可用")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("模糊搜索执行日志"), {
      target: { value: "report" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重新查询" }));

    expect(await screen.findByText("mss-report-skill")).toBeInTheDocument();
    expect(screen.getByLabelText("模糊搜索执行日志")).toHaveValue("report");
  });

  it("polls while a visible execution is running and stops after it finishes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState(null, "", "/audit?tab=skill-executions");
    listSkillExecutionsMock
      .mockResolvedValueOnce({
        items: [{ ...execution, status: "running", endedAt: undefined }],
        total: 1,
        page: 1,
        pageSize: 10,
      })
      .mockResolvedValue({
        items: [{ ...execution, status: "succeeded", errorMessage: "" }],
        total: 1,
        page: 1,
        pageSize: 10,
      });
    render(<Audit />);
    await waitFor(() => expect(listSkillExecutionsMock).toHaveBeenCalledTimes(1));

    await act(async () => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(listSkillExecutionsMock).toHaveBeenCalledTimes(2));
    await act(async () => vi.advanceTimersByTimeAsync(10000));

    expect(listSkillExecutionsMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("opens an execution detail with lifecycle and redacted result fields", async () => {
    window.history.replaceState(null, "", "/audit?tab=skill-executions");
    listSkillExecutionsMock.mockResolvedValue({
      items: [execution],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    render(<Audit />);
    fireEvent.click(await screen.findByRole("button", { name: "查看执行 run-a 详情" }));

    expect(await screen.findByRole("dialog", { name: "Skill 执行详情" })).toBeInTheDocument();
    expect(getSkillExecutionMock).toHaveBeenCalledWith("run-a");
    expect(screen.getByText("正在生成周报")).toBeInTheDocument();
    expect(screen.getByText("report_failed")).toBeInTheDocument();
    expect(screen.getByText("导出测试客户周报")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
  });

  it.each([null, "{invalid-json"])(
    "falls back for an unusable progress payload: %s",
    async (progressJson) => {
      window.history.replaceState(null, "", "/audit?tab=skill-executions");
      listSkillExecutionsMock.mockResolvedValue({
        items: [execution],
        total: 1,
        page: 1,
        pageSize: 10,
      });
      getSkillExecutionMock.mockResolvedValue({ ...execution, progressJson });
      render(<Audit />);
      fireEvent.click(await screen.findByRole("button", { name: "查看执行 run-a 详情" }));

      expect(await screen.findByText("暂无进度明细")).toBeInTheDocument();
    },
  );

  it("retries a failed execution detail request inside the modal", async () => {
    window.history.replaceState(null, "", "/audit?tab=skill-executions");
    listSkillExecutionsMock.mockResolvedValue({
      items: [execution],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    getSkillExecutionMock
      .mockRejectedValueOnce(new Error("执行详情暂时不可用"))
      .mockResolvedValueOnce({ ...execution, progressJson: "[]" });
    render(<Audit />);
    fireEvent.click(await screen.findByRole("button", { name: "查看执行 run-a 详情" }));

    expect(await screen.findByText("执行详情暂时不可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载执行详情" }));
    expect(await screen.findByText("暂无进度明细")).toBeInTheDocument();
    expect(getSkillExecutionMock).toHaveBeenCalledTimes(2);
  });

  it("keeps long execution text inside the detail modal", async () => {
    window.history.replaceState(null, "", "/audit?tab=skill-executions");
    const longError = `报告生成失败：${"超长错误上下文".repeat(80)}`;
    listSkillExecutionsMock.mockResolvedValue({
      items: [{ ...execution, errorMessage: longError }],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    getSkillExecutionMock.mockResolvedValue({
      ...execution,
      errorMessage: longError,
      progressJson: "[]",
    });
    render(<Audit />);
    fireEvent.click(await screen.findByRole("button", { name: "查看执行 run-a 详情" }));

    const dialog = await screen.findByRole("dialog", { name: "Skill 执行详情" });
    const detailText = within(dialog).getByText(longError);
    expect(detailText.className).toMatch(/resultText/);
    expect(dialog).toBeInTheDocument();
  });
});
