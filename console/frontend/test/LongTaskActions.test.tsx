import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import type { LongTask } from "../src/api";
import { LongTaskActions } from "../src/pages/long-tasks/LongTaskActions";

// LongTaskControlS26 [integration] 真实边界：Testing Library 渲染真实 Semi 操作
// 组件（Popconfirm/Tooltip/Button），纯 props/events，不发 HTTP。

function task(overrides: Partial<LongTask> = {}): LongTask {
  return {
    taskId: "task-1",
    podId: "pod-a",
    humanUserId: "human-a",
    poolKey: "agent:alice:wecom:direct:wx-1",
    poolQueued: 0,
    poolRunning: 1,
    poolLimit: 2,
    agentId: "alice",
    peerId: "wx-1",
    skillName: "report-customer",
    skillRoot: "/skills/report",
    status: "running",
    stateRevision: 1,
    canCancel: true,
    submittedAt: "2026-10-15T08:00:00.000Z",
    updatedAt: "2026-10-15T08:00:00.000Z",
    lastSeenAt: "2026-10-15T08:00:00.000Z",
    ...overrides,
  };
}

describe("LongTaskActions", () => {
  it("LongTaskControlS26 cancels a queued task directly with its stable taskId", () => {
    const onCancel = vi.fn();
    render(
      <LongTaskActions
        task={task({ status: "queued", canCancel: true })}
        busy={false}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "取消排队" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith("task-1");
  });

  it("LongTaskControlS26 confirms running termination with skill and task id", async () => {
    const onCancel = vi.fn();
    render(<LongTaskActions task={task()} busy={false} onCancel={onCancel} />);

    const trigger = screen.getByRole("button", { name: "终止任务" });
    fireEvent.click(trigger);
    const dialog = await screen.findByText("终止该任务？");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/report-customer（任务 task-1）/)).toBeInTheDocument();
    expect(screen.getByText(/已完成的外部操作与已发送的消息不会撤回/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith("task-1"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("LongTaskControlS26 does not submit when the confirmation is dismissed", async () => {
    const onCancel = vi.fn();
    render(<LongTaskActions task={task()} busy={false} onCancel={onCancel} />);

    const trigger = screen.getByRole("button", { name: "终止任务" });
    fireEvent.click(trigger);
    await screen.findByText("终止该任务？");
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("LongTaskControlS26 disables cancelling rows and never offers retry on terminal rows", () => {
    const onCancel = vi.fn();
    const { unmount } = render(
      <LongTaskActions task={task({ status: "cancelling" })} busy={false} onCancel={onCancel} />,
    );
    const cancelling = screen.getByRole("button", { name: "终止中" });
    expect(cancelling).toBeDisabled();
    fireEvent.click(cancelling);
    expect(onCancel).not.toHaveBeenCalled();
    unmount();

    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      const rendered = render(
        <LongTaskActions task={task({ status })} busy={false} onCancel={onCancel} />,
      );
      expect(screen.queryByRole("button", { name: "终止任务" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "取消排队" })).not.toBeInTheDocument();
      expect(screen.queryByText(/重试/u)).not.toBeInTheDocument();
      rendered.unmount();
    }
  });

  it("LongTaskControlS26 shows a readable reason when the worker cannot cancel", async () => {
    render(
      <LongTaskActions
        task={task({
          status: "running",
          canCancel: false,
          cancelUnavailableReason: "worker_unsupported",
        })}
        busy={false}
        onCancel={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "终止任务" });
    expect(trigger).toBeDisabled();
    fireEvent.mouseEnter(trigger.parentElement as Element);
    await waitFor(() =>
      expect(screen.getByText("当前 Worker 不支持任务取消，请升级运行时")).toBeInTheDocument(),
    );

    const busy = render(
      <LongTaskActions
        task={task({ status: "queued", canCancel: true })}
        busy
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button", { name: "取消排队" })[0]).toBeDisabled();
    busy.unmount();
  });
});
