import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LongTask, LongTaskListResult, LongTaskPool } from "../src/api";
import { LongTasks } from "../src/pages/LongTasks";

const apiMocks = vi.hoisted(() => ({
  listLongTasks: vi.fn(),
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
});

describe("LongTasks", () => {
  it("groups tasks by agent-user pool and shows consumption metrics", async () => {
    const onOpenPod = vi.fn();
    render(<LongTasks onOpenPod={onOpenPod} />);

    expect(screen.getByRole("heading", { name: "长任务" })).toBeInTheDocument();
    const poolTitle = await screen.findByText("池 agent:alice:wecom:direct:wx-1");
    const pool = poolTitle.closest("section");
    if (!pool) throw new Error("pool section not found");

    expect(within(pool).getByLabelText("待消费: 1")).toBeInTheDocument();
    expect(within(pool).getByLabelText("执行中: 1")).toBeInTheDocument();
    expect(within(pool).getByLabelText("上限: 2")).toBeInTheDocument();
    expect(within(pool).getByText("task-running")).toBeInTheDocument();
    expect(within(pool).getByText("task-queued")).toBeInTheDocument();
    expect(within(pool).getByText(formatTime(runningTask.startedAt))).toBeInTheDocument();

    fireEvent.click(within(pool).getAllByRole("button", { name: "pod-a" })[0]);
    expect(onOpenPod).toHaveBeenCalledWith("pod-a");
  });

  it("submits typed filters through the API client", async () => {
    render(<LongTasks />);
    await screen.findByText("池 agent:alice:wecom:direct:wx-1");

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

    const poolTitle = await screen.findByText("池 agent:alice:wecom:direct:wx-1");
    const pool = poolTitle.closest("section");
    if (!pool) throw new Error("pool section not found");

    expect(within(pool).getByLabelText("待消费: 4")).toBeInTheDocument();
    expect(within(pool).getByLabelText("执行中: 2")).toBeInTheDocument();
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
      expect(screen.getByText("池 agent:alice:wecom:direct:wx-1")).toBeInTheDocument();
      const refresh = screen.getByRole("button", { name: "刷新" });

      await act(async () => {
        fireEvent.click(refresh);
      });
      expect(refresh).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
        background.resolve(pageResult({ items: [runningTask], pools: [poolSummary], total: 1 }));
        await Promise.resolve();
      });
      expect(apiMocks.listLongTasks).toHaveBeenCalledTimes(3);
      expect(refresh).toBeDisabled();

      await act(async () => {
        foreground.resolve(pageResult({ items: [runningTask], pools: [poolSummary], total: 1 }));
        await Promise.resolve();
      });
      expect(refresh).not.toBeDisabled();
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

function formatTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
