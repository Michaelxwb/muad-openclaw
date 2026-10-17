import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api";
import type { LongTask, LongTaskListResult, LongTaskPool } from "../src/api";
import {
  LONG_TASK_POD_USER_COLUMN_WIDTH,
  LONG_TASK_TABLE_MIN_WIDTH,
  LONG_TASK_TABLE_SCROLL_X,
  LongTasks,
} from "../src/pages/LongTasks";
import tableStyles from "../src/pages/LongTasks.module.css";

const apiMocks = vi.hoisted(() => ({
  listLongTasks: vi.fn(),
  listPods: vi.fn(),
  cancelLongTask: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

const runningTask: LongTask = {
  taskId: "task-running",
  podId: "pod-a",
  humanUserId: "human-a",
  humanUserName: "张三",
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
    expect(columnStyles[0]).toContain("width: 250px");
    expect(columnStyles[1]).toContain("width: 240px");
    expect(columnStyles[2]).toContain(`width: ${LONG_TASK_POD_USER_COLUMN_WIDTH}px`);
    expect(columnStyles[3]).toContain("width: 220px");
    expect(columnStyles[8]).not.toContain("width");

    const podButtons = screen.getAllByRole("button", { name: /主节点/ });
    const podUserCell = podButtons[0].closest('[role="gridcell"]');
    if (!podUserCell?.firstElementChild) throw new Error("missing pod/user cell content");
    const podUserLines = Array.from(podUserCell.firstElementChild.children);
    expect(podUserLines).toHaveLength(3);
    expect(podUserLines[0]).toHaveTextContent("主节点");
    expect(podUserLines[0]).toHaveTextContent("pod-a");
    expect(podUserLines[1]).toHaveTextContent("alice");
    expect(podUserLines[2]).toHaveTextContent("张三");

    // 长池名单行截断：承载省略号样式，避免长 key 竖排撑高行
    const poolKeys = screen.getAllByText("agent:alice:wecom:direct:wx-1");
    expect(poolKeys[0].className).toContain(tableStyles.clipLine);

    fireEvent.click(podButtons[0]);
    expect(onOpenPod).toHaveBeenCalledWith("pod-a");
  });

  it("renders the backend-resolved user name and falls back to the id", async () => {
    apiMocks.listLongTasks.mockResolvedValueOnce(
      pageResult({
        items: [
          { ...runningTask, taskId: "task-named", humanUserName: "林海(10636)" },
          { ...runningTask, taskId: "task-orphan", humanUserId: "gone-user", humanUserName: "" },
        ],
        pools: [poolSummary],
        total: 2,
      }),
    );

    render(<LongTasks />);

    expect(await screen.findByText("林海(10636)")).toBeInTheDocument();
    expect(screen.getByText("gone-user")).toBeInTheDocument();
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

describe("Long Task cancel actions", () => {
  function cancelableTask(
    taskId: string,
    status: LongTask["status"],
    extra: Partial<LongTask> = {},
  ): LongTask {
    return {
      ...runningTask,
      taskId,
      status,
      stateRevision: 1,
      canCancel: true,
      ...extra,
    };
  }

  beforeEach(() => {
    apiMocks.cancelLongTask.mockReset();
  });

  it("LongTaskControlS09 offers actions only for queued/running and blocks repeats", async () => {
    apiMocks.listLongTasks.mockResolvedValue(
      pageResult({
        items: [
          cancelableTask("task-queued", "queued"),
          cancelableTask("task-running-2", "running"),
          cancelableTask("task-cancelling", "cancelling", { cancelRequestedBy: "admin" }),
          cancelableTask("task-succeeded", "succeeded"),
          cancelableTask("task-failed", "failed", { errorCode: "long_task_failed" }),
          cancelableTask("task-cancelled", "cancelled", {
            cancelledAt: "2026-08-09T10:05:00.000Z",
          }),
        ],
        pools: [poolSummary],
        total: 6,
      }),
    );
    render(<LongTasks />);

    expect(await screen.findByRole("button", { name: "取消排队" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "终止任务" })).toHaveLength(1);
    const cancellingButton = screen.getByRole("button", { name: "终止中" });
    expect(cancellingButton).toBeDisabled();
    fireEvent.click(cancellingButton);
    expect(apiMocks.cancelLongTask).not.toHaveBeenCalled();
    expect(screen.queryByText(/重试/u)).not.toBeInTheDocument();
  });

  it("LongTaskControlS09 cancels a queued task with a single request, keeps 202 as accepted and refreshes", async () => {
    apiMocks.listLongTasks.mockResolvedValue(
      pageResult({
        items: [cancelableTask("task-queued", "queued")],
        pools: [poolSummary],
        total: 1,
      }),
    );
    apiMocks.cancelLongTask.mockResolvedValue({
      taskId: "task-queued",
      outcome: "cancel_requested",
      status: "cancelling",
      stateRevision: 2,
    });
    render(<LongTasks />);

    const button = await screen.findByRole("button", { name: "取消排队" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(apiMocks.cancelLongTask).toHaveBeenCalledTimes(1));
    expect(apiMocks.cancelLongTask).toHaveBeenCalledWith("task-queued");
    expect(await screen.findByText("终止请求已接受，等待停止确认")).toBeInTheDocument();
    // 202 不冒充已取消：不出现取消完成文案，并以一次列表刷新呈现 Worker 实际状态。
    expect(screen.queryByText("任务已取消")).not.toBeInTheDocument();
    await waitFor(() => expect(apiMocks.listLongTasks.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("LongTaskControlS09 dismisses confirmation without a request and surfaces failures without retry", async () => {
    apiMocks.listLongTasks.mockResolvedValue(
      pageResult({
        items: [cancelableTask("task-running-2", "running")],
        pools: [poolSummary],
        total: 1,
      }),
    );
    apiMocks.cancelLongTask.mockRejectedValue(
      new ApiError("当前 Worker 不支持任务取消，请升级运行时", 503, 41003),
    );
    render(<LongTasks />);

    const trigger = await screen.findByRole("button", { name: "终止任务" });
    fireEvent.click(trigger);
    await screen.findByText("终止该任务？");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(apiMocks.cancelLongTask).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    await screen.findByText("终止该任务？");
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(apiMocks.cancelLongTask).toHaveBeenCalledWith("task-running-2"));
    expect(await screen.findByText(/不支持任务取消/u)).toBeInTheDocument();
    expect(screen.queryByText(/重试/u)).not.toBeInTheDocument();
  });

  it("LongTaskControlS09 discards stale list responses so a cancelled row never regresses", async () => {
    let resolveOld: (value: LongTaskListResult) => void = () => {};
    let resolveNew: (value: LongTaskListResult) => void = () => {};
    apiMocks.listLongTasks
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNew = resolve;
          }),
      );
    render(<LongTasks />);

    fireEvent.change(screen.getByLabelText("查询长任务"), { target: { value: "report" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(apiMocks.listLongTasks).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNew(
        pageResult({ items: [cancelableTask("task-done", "cancelled")], pools: [], total: 1 }),
      );
    });
    expect(await screen.findByText("已取消")).toBeInTheDocument();

    await act(async () => {
      resolveOld(
        pageResult({
          items: [cancelableTask("task-done", "running")],
          pools: [poolSummary],
          total: 1,
        }),
      );
    });
    await waitFor(() => expect(screen.getByText("已取消")).toBeInTheDocument());
    expect(screen.queryByText("运行中")).not.toBeInTheDocument();
  });
});
