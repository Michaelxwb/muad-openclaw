import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LongTask, LongTaskListResult, LongTaskPool } from "../src/api";
import {
  LONG_TASK_POD_USER_COLUMN_WIDTH,
  LONG_TASK_TABLE_MIN_WIDTH,
  LONG_TASK_TABLE_SCROLL_X,
  LongTasks,
} from "../src/pages/LongTasks";

const apiMocks = vi.hoisted(() => ({
  listLongTasks: vi.fn(),
  listAllHumanUsers: vi.fn(),
  listPods: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

const runningTask: LongTask = {
  taskId: "task-running",
  podId: "pod-a",
  humanUserId: "human-a",
  poolKey: "agent:alice:wecom:direct:wx-1",
  poolQueued: 1,
  poolRunning: 1,
  poolLimit: 2,
  agentId: "alice",
  peerId: "wx-1",
  skillName: "report-customer",
  skillRoot: "/skills/report",
  status: "running",
  submittedAt: "2026-08-09T10:00:00.000Z",
  startedAt: "2026-08-09T10:00:01.000Z",
  updatedAt: "2026-08-09T10:00:01.000Z",
  lastSeenAt: "2026-08-09T10:00:01.000Z",
};

const queuedTask: LongTask = {
  ...runningTask,
  taskId: "task-queued",
  status: "queued",
  startedAt: undefined,
  submittedAt: "2026-08-09T10:02:00.000Z",
  updatedAt: "2026-08-09T10:02:00.000Z",
  lastSeenAt: "2026-08-09T10:02:00.000Z",
};

const poolSummary: LongTaskPool = {
  podId: "pod-a",
  humanUserId: "human-a",
  poolKey: "agent:alice:wecom:direct:wx-1",
  poolQueued: 1,
  poolRunning: 1,
  poolLimit: 2,
  agentId: "alice",
  peerId: "wx-1",
  updatedAt: "2026-08-09T10:02:00.000Z",
  lastSeenAt: "2026-08-09T10:02:00.000Z",
};

beforeEach(() => {
  apiMocks.listLongTasks.mockReset().mockResolvedValue(
    pageResult({
      items: [runningTask, queuedTask],
      pools: [poolSummary],
      total: 2,
    }),
  );
  apiMocks.listAllHumanUsers.mockReset().mockResolvedValue({
    items: [{ humanUserId: "human-a", displayName: "张三" }],
    total: 1,
    page: 1,
    pageSize: 1000,
  });
  apiMocks.listPods.mockReset().mockResolvedValue({
    items: [{ podId: "pod-a", displayName: "主节点" }],
    total: 1,
    page: 1,
    pageSize: 10,
  });
});

describe("LongTasks", () => {
  it("renders a flat task table with agent pool as a row field", async () => {
    const onOpenPod = vi.fn();
    render(<LongTasks onOpenPod={onOpenPod} />);

    expect(screen.getByRole("heading", { name: "长任务" })).toBeInTheDocument();
    expect(await screen.findByText("Agent 池")).toBeInTheDocument();
    expect(screen.getByText("Pod / 用户")).toBeInTheDocument();
    expect(screen.getByText("task-running")).toBeInTheDocument();
    expect(screen.getByText("task-queued")).toBeInTheDocument();
    expect(screen.getAllByText("alice")).toHaveLength(2);
    expect(screen.getAllByText("张三")).toHaveLength(2);
    expect(screen.getAllByText("主节点")).toHaveLength(2);
    expect(screen.getAllByText("agent:alice:wecom:direct:wx-1")).toHaveLength(2);
    expect(screen.getAllByLabelText("待消费: 1; 执行中: 1; 上限: 2")).toHaveLength(2);
    expect(screen.getAllByText(formatDate(runningTask.startedAt)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(formatClock(runningTask.startedAt)).length).toBeGreaterThan(0);
    const taskTable = screen.getByRole("grid");
    const taskTableWrapper = taskTable.closest(".semi-table-wrapper");
    if (!taskTableWrapper) throw new Error("missing long task table wrapper");
    expect(taskTable).toHaveStyle({ width: LONG_TASK_TABLE_SCROLL_X });
    expect(taskTableWrapper.getAttribute("style")).toContain(
      `--long-task-table-min-width: ${LONG_TASK_TABLE_MIN_WIDTH}px`,
    );
    const columnStyles = Array.from(taskTable.querySelectorAll("col")).map(
      (column) => column.getAttribute("style") ?? "",
    );
    expect(columnStyles[0]).not.toContain("width");
    expect(columnStyles[1]).not.toContain("width");
    expect(columnStyles[2]).toContain(`width: ${LONG_TASK_POD_USER_COLUMN_WIDTH}px`);
    expect(columnStyles[3]).not.toContain("width");
    expect(columnStyles[8]).toContain("width: 130px");

    const podButtons = screen.getAllByRole("button", { name: /主节点/ });
    const podUserCell = podButtons[0].closest('[role="gridcell"]');
    if (!podUserCell?.firstElementChild) throw new Error("missing pod/user cell content");
    const podUserLines = Array.from(podUserCell.firstElementChild.children);
    expect(podUserLines).toHaveLength(3);
    expect(podUserLines[0]).toHaveTextContent("主节点");
    expect(podUserLines[0]).toHaveTextContent("pod-a");
    expect(podUserLines[1]).toHaveTextContent("alice");
    expect(podUserLines[2]).toHaveTextContent("张三");

    fireEvent.click(podButtons[0]);
    expect(onOpenPod).toHaveBeenCalledWith("pod-a");
  });

  it("submits typed filters through the API client", async () => {
    render(<LongTasks />);
    await screen.findByText("task-running");

    fireEvent.change(screen.getByLabelText("查询长任务"), { target: { value: "report" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    await waitFor(() =>
      expect(apiMocks.listLongTasks).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 10,
        q: "report",
      }),
    );
  });

  it("shows localized empty state", async () => {
    apiMocks.listLongTasks.mockResolvedValueOnce(pageResult({ items: [], pools: [], total: 0 }));

    render(<LongTasks />);

    expect(await screen.findByText("暂无长任务")).toBeInTheDocument();
  });

  it("uses authoritative pool counts instead of current page row counts", async () => {
    apiMocks.listLongTasks.mockResolvedValueOnce(
      pageResult({
        items: [runningTask],
        pools: [{ ...poolSummary, poolQueued: 4, poolRunning: 2 }],
        total: 8,
      }),
    );

    render(<LongTasks />);

    await screen.findByText("task-running");
    expect(screen.getByLabelText("待消费: 4; 执行中: 2; 上限: 2")).toBeInTheDocument();
  });

  it("does not leave foreground refresh loading after a background poll wins the data race", async () => {
    vi.useFakeTimers();
    const foreground = deferred<LongTaskListResult>();
    const background = deferred<LongTaskListResult>();
    apiMocks.listLongTasks
      .mockResolvedValueOnce(pageResult({ items: [runningTask], pools: [poolSummary], total: 1 }))
      .mockImplementationOnce(() => foreground.promise)
      .mockImplementationOnce(() => background.promise);
    try {
      render(<LongTasks />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("task-running")).toBeInTheDocument();
      const refresh = screen.getByRole("button", { name: "刷新" });

      await act(async () => {
        fireEvent.click(refresh);
        await Promise.resolve();
      });
      expect(apiMocks.listLongTasks).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "刷新" })).toHaveAttribute("aria-disabled", "true");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
        background.resolve(pageResult({ items: [runningTask], pools: [poolSummary], total: 1 }));
        await Promise.resolve();
      });
      expect(apiMocks.listLongTasks).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("button", { name: "刷新" })).toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        foreground.resolve(pageResult({ items: [runningTask], pools: [poolSummary], total: 1 }));
        await Promise.resolve();
      });
      expect(screen.getByRole("button", { name: "刷新" })).toHaveAttribute(
        "aria-disabled",
        "false",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

function pageResult(overrides: Partial<LongTaskListResult>): LongTaskListResult {
  return {
    items: [],
    pools: [],
    total: 0,
    page: 1,
    pageSize: 10,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function formatDate(value?: string) {
  const date = parsedDate(value);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function formatClock(value?: string) {
  const date = parsedDate(value);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function parsedDate(value?: string) {
  if (!value) throw new Error("missing test date");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid test date: ${value}`);
  return date;
}
