import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillExecutionTrace, SkillHealthItem } from "../src/api";
import { ApiError } from "../src/api";
import { Audit } from "../src/pages/Audit";
import { TraceTimeline } from "../src/pages/audit/TraceTimeline";

const auditMock = vi.hoisted(() => vi.fn());
const listSkillExecutionsMock = vi.hoisted(() => vi.fn());
const listAllHumanUsersMock = vi.hoisted(() => vi.fn());
const listPodsMock = vi.hoisted(() => vi.fn());
const getSkillExecutionTraceMock = vi.hoisted(() => vi.fn());
const listSkillHealthMock = vi.hoisted(() => vi.fn());

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
      getSkillExecutionTrace: getSkillExecutionTraceMock,
      listSkillHealth: listSkillHealthMock,
    },
  };
});

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

const trace: SkillExecutionTrace = {
  metrics: {
    requestCount: 3,
    errorCount: 1,
    distinctHosts: 1,
    maxBurstPer10s: 3,
    topInterfaces: [{ host: "mssw", method: "GET", path: "/api/v1/targets/{id}", count: 2 }],
    detailTruncated: false,
    aborted: false,
    updatedAt: "2026-07-14T10:00:04Z",
  },
  events: [
    {
      eventId: "event-1",
      seq: 1,
      occurredAt: "2026-07-14T10:00:01.000Z",
      kind: "exec",
      status: "ok",
      durationMs: 1200,
      summary: "python3 scripts/run.py",
      detail: "exit=0",
    },
    {
      eventId: "event-2",
      seq: 2,
      occurredAt: "2026-07-14T10:00:02.100Z",
      kind: "http",
      status: "200",
      durationMs: 310,
      summary: "GET mssw /api/v1/targets/{id}",
      detail: "",
      traceId: "6f0e4b8a-6c1f-4a4e-9d7a-2f0f6a7b8c9d",
    },
    {
      eventId: "event-3",
      seq: 3,
      occurredAt: "2026-07-14T10:00:03.100Z",
      kind: "http",
      status: "500",
      durationMs: 420,
      summary: "POST mssw /api/v1/report",
      detail: "upstream error",
    },
  ],
};

const healthA: SkillHealthItem = {
  skillName: "mss-report-skill",
  skillScope: "private",
  humanUserId: "user-a",
  humanUserName: "张三",
  executions: 4,
  abortedCount: 2,
  flaggedCount: 3,
  maxRequests: 1200,
  errorRate: 0.25,
  topInterfaces: [{ host: "mssw", method: "GET", path: "/api/v1/targets/{id}", count: 990 }],
  lastExecutionAt: "2026-07-14T10:00:00Z",
};

const healthB: SkillHealthItem = {
  ...healthA,
  humanUserId: "user-b",
  humanUserName: "李四",
  executions: 2,
  abortedCount: 0,
  flaggedCount: 0,
  maxRequests: 40,
  errorRate: 0,
};

beforeEach(() => {
  window.history.replaceState(null, "", "/audit?tab=operations");
  auditMock.mockReset();
  auditMock.mockResolvedValue({ items: [], total: 0 });
  listSkillExecutionsMock.mockReset();
  listSkillExecutionsMock.mockResolvedValue({
    items: [execution],
    total: 1,
    page: 1,
    pageSize: 10,
  });
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
  getSkillExecutionTraceMock.mockReset();
  getSkillExecutionTraceMock.mockResolvedValue(trace);
  listSkillHealthMock.mockReset();
  listSkillHealthMock.mockResolvedValue({ items: [healthA, healthB] });
});

async function renderSkillExecutions() {
  window.history.replaceState(null, "", "/audit?tab=skill-executions");
  render(<Audit />);
  return screen.findByRole("button", { name: "查看执行明细 run-a" });
}

async function openTraceDrawer() {
  const button = await renderSkillExecutions();
  fireEvent.click(button);
  await screen.findByText("请求数");
}

describe("execution trace drawer", () => {
  it("renders metrics and events in seq order with stable event ids", async () => {
    await openTraceDrawer();

    expect(screen.getByTestId("trace-request-count")).toHaveTextContent("3");
    expect(screen.getByTestId("trace-error-count")).toHaveTextContent("1");
    expect(screen.getByTestId("trace-duration")).toHaveTextContent("2.1s");
    expect(screen.getAllByText("GET mssw /api/v1/targets/{id}").length).toBeGreaterThan(0);
    expect(screen.getByText("× 2")).toBeInTheDocument();

    const rows = screen.getAllByTestId("trace-event");
    expect(rows.map((row) => row.dataset.eventId)).toEqual(["event-1", "event-2", "event-3"]);
    expect(rows[1]).toHaveTextContent("GET mssw /api/v1/targets/{id}");
    expect(rows[1]).toHaveTextContent("Traceid: 6f0e4b8a-6c1f-4a4e-9d7a-2f0f6a7b8c9d");
    expect(rows[2]).not.toHaveTextContent("Traceid");
    expect(rows[1]).toHaveTextContent("200");
    expect(rows[1]).toHaveTextContent("310ms");
    expect(await screen.findByText("python3 scripts/run.py")).toBeInTheDocument();
  });

  it("highlights aborted executions and abort events", async () => {
    getSkillExecutionTraceMock.mockResolvedValue({
      metrics: {
        ...trace.metrics,
        requestCount: 1001,
        aborted: true,
        abortReason: "request_limit",
        abortInterface: "GET mssw /api/v1/targets/{id}",
        abortCount: 1001,
      },
      events: [
        ...trace.events,
        {
          eventId: "event-abort",
          seq: 4,
          occurredAt: "2026-07-14T10:00:04.000Z",
          kind: "abort",
          status: "aborted",
          summary: "request limit reached",
          detail: "",
        },
      ],
    });

    await openTraceDrawer();

    expect(screen.getByText("已因请求超限终止")).toBeInTheDocument();
    expect(screen.getAllByText(/GET mssw \/api\/v1\/targets\/\{id\}/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1001/).length).toBeGreaterThan(0);
    const abortRow = screen
      .getAllByTestId("trace-event")
      .find((row) => row.dataset.eventId === "event-abort");
    expect(abortRow).toHaveAttribute("data-highlighted", "true");
  });

  it("keeps the truncated banner visible with the request count", async () => {
    getSkillExecutionTraceMock.mockResolvedValue({
      ...trace,
      metrics: { ...trace.metrics!, requestCount: 1000, detailTruncated: true },
    });

    await openTraceDrawer();

    expect(screen.getByText("明细已截断，共 1000 次请求")).toBeInTheDocument();
  });

  it("shows a legacy hint instead of an error when only exec events exist", async () => {
    getSkillExecutionTraceMock.mockResolvedValue({
      metrics: null,
      events: [trace.events[0]],
    });

    await openTraceDrawer();

    expect(screen.getByText(/未使用统一客户端/)).toBeInTheDocument();
    expect(screen.getByText("python3 scripts/run.py")).toBeInTheDocument();
    expect(screen.queryByText("加载执行明细失败")).not.toBeInTheDocument();
  });

  it("shows an empty state when the execution has no events", async () => {
    getSkillExecutionTraceMock.mockResolvedValue({ metrics: null, events: [] });

    await openTraceDrawer();

    expect(screen.getByText("该执行暂无明细事件")).toBeInTheDocument();
  });

  it("renders a banner, technical detail and retry when the request fails", async () => {
    getSkillExecutionTraceMock
      .mockRejectedValueOnce(new ApiError("trace 加载失败", 500, 50001, "stack detail"))
      .mockResolvedValueOnce(trace);

    const button = await renderSkillExecutions();
    fireEvent.click(button);

    expect(await screen.findByText("trace 加载失败")).toBeInTheDocument();
    expect(screen.getByText("技术详情")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("python3 scripts/run.py")).toBeInTheDocument();
    expect(getSkillExecutionTraceMock).toHaveBeenCalledTimes(2);
  });

  it("maps a missing execution to the not-found state", async () => {
    getSkillExecutionTraceMock.mockRejectedValue(new ApiError("not found", 404));

    const button = await renderSkillExecutions();
    fireEvent.click(button);

    expect(await screen.findByText("执行不存在")).toBeInTheDocument();
  });

  it("renders 2000 events progressively so the first screen stays responsive", () => {
    const events = Array.from({ length: 2000 }, (_, index) => ({
      eventId: `bulk-${index}`,
      seq: index + 1,
      occurredAt: new Date(Date.UTC(2026, 6, 14, 10, 0, index)).toISOString(),
      kind: "http",
      status: "200",
      durationMs: 10,
      summary: `GET mssw /api/v1/items/${index}`,
      detail: "",
    }));

    render(<TraceTimeline events={events} />);

    expect(screen.getByText("GET mssw /api/v1/items/0")).toBeInTheDocument();
    expect(screen.queryByText("GET mssw /api/v1/items/1999")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /加载更多/ })).toBeInTheDocument();
  });
});

async function renderHealthTab() {
  window.history.replaceState(null, "", "/audit?tab=skill-health");
  render(<Audit />);
}

async function openHealthTab() {
  await renderHealthTab();
  await screen.findByText("张三");
}

describe("Skill health tab", () => {
  it("lists both users of the same private Skill and drills down with humanUserId", async () => {
    await openHealthTab();

    expect(screen.getAllByText("mss-report-skill")).toHaveLength(2);
    expect(screen.getByText("李四")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看执行日志 mss-report-skill 张三" }));

    await waitFor(() =>
      expect(listSkillExecutionsMock).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 10,
        humanUserId: "user-a",
        skillName: "mss-report-skill",
      }),
    );
    expect(screen.getByRole("tab", { name: "Skill 执行日志" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText(/已按用户 user-a · Skill mss-report-skill 过滤/)).toBeInTheDocument();
  });

  it("loads the default 7d window and shows the empty state", async () => {
    listSkillHealthMock.mockResolvedValue({ items: [] });

    await renderHealthTab();

    expect(listSkillHealthMock).toHaveBeenCalledWith({ window: "7d" });
    expect(await screen.findByText("该窗口内暂无 Skill 执行数据")).toBeInTheDocument();
  });

  it("refreshes in the background when switching windows without clearing rows", async () => {
    let resolveSecond: ((value: { items: SkillHealthItem[] }) => void) | undefined;
    listSkillHealthMock.mockResolvedValueOnce({ items: [healthA] }).mockImplementationOnce(
      () =>
        new Promise<{ items: SkillHealthItem[] }>((resolve) => {
          resolveSecond = resolve;
        }),
    );

    await openHealthTab();
    fireEvent.click(screen.getByRole("button", { name: "24 小时" }));

    expect(screen.getByText("张三")).toBeInTheDocument();
    await waitFor(() => expect(listSkillHealthMock).toHaveBeenLastCalledWith({ window: "24h" }));

    await act(async () => {
      resolveSecond?.({ items: [healthB] });
    });
    expect(await screen.findByText("李四")).toBeInTheDocument();
  });

  it("shows a banner and retry when health data fails", async () => {
    listSkillHealthMock
      .mockRejectedValueOnce(new ApiError("健康数据加载失败", 500, 50002, "detail"))
      .mockResolvedValueOnce({ items: [healthA] });

    await renderHealthTab();

    expect(await screen.findByText("健康数据加载失败")).toBeInTheDocument();
    expect(screen.getByText("技术详情")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("张三")).toBeInTheDocument();
  });
});
