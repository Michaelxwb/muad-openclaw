import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      previewSessionCancel: vi.fn(),
      cancelSession: vi.fn(),
    },
  };
});

import { api, ApiError } from "../src/api";
import type {
  Identity,
  SessionCancelPreview,
  SessionCancelProcess,
  SessionCancelResultData,
} from "../src/api";
import {
  ProcessPreviewTable,
  SessionCancelDialog,
} from "../src/components/human-users/SessionCancelDialog";

// S-09/S-10, E-07..E-11, B-06..B-08 [integration/unit] 真实边界：Testing Library
// 渲染真实 Semi Modal/Table/Button/Tag/Toast；只有 src/api.ts 被 mock。

const previewMock = vi.mocked(api.previewSessionCancel);
const cancelMock = vi.mocked(api.cancelSession);

const identity: Identity = {
  identityId: "identity-1",
  channel: "wecom",
  openclawChannel: "wecom",
  accountId: "default",
  externalId: "john",
  externalIdType: "user_id",
  peerKind: "direct",
  status: "active",
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
};

function processRow(overrides: Partial<SessionCancelProcess> = {}): SessionCancelProcess {
  return {
    pid: 4028,
    pgid: 4028,
    startTime: 1234567,
    uid: 1000,
    leader: true,
    ageSeconds: 131,
    cmdline: "sh -c python3 scripts/run.py --seconds 180",
    fingerprint: "fp-a",
    ...overrides,
  };
}

function preview(overrides: Partial<SessionCancelPreview> = {}): SessionCancelPreview {
  return {
    sessionKey: "agent:john:wecom:direct:john",
    agentId: "john",
    activeRun: { active: true, sessionId: "run-1" },
    processes: [processRow()],
    skipped: { notOwner: 0, envMismatch: 0, permissionDenied: 0 },
    ...overrides,
  };
}

function result(overrides: Partial<SessionCancelResultData> = {}): SessionCancelResultData {
  return {
    aborted: true,
    drained: true,
    confirmed: true,
    killed: 1,
    remaining: [],
    processes: [{ pid: 4028, outcome: "terminated", reason: "sigterm" }],
    ...overrides,
  };
}

function renderDialog() {
  const onClose = vi.fn();
  const onCancelled = vi.fn();
  render(
    <SessionCancelDialog
      visible
      humanUserId="user-1"
      identity={identity}
      onClose={onClose}
      onCancelled={onCancelled}
    />,
  );
  return { onClose, onCancelled };
}

function confirmButton() {
  return screen.getByRole("button", { name: /终止会话并结束/ });
}

beforeEach(() => {
  previewMock.mockReset();
  cancelMock.mockReset();
});

describe("SessionCancelDialog", () => {
  it("S-09 renders the empty state and disables confirmation when nothing is running", async () => {
    previewMock.mockResolvedValue(preview({ activeRun: { active: false }, processes: [] }));
    renderDialog();

    expect(await screen.findByText("没有正在运行的任务或后台进程")).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("S-10 shows skipped outcomes and remaining pids instead of reporting full success", async () => {
    previewMock.mockResolvedValue(preview());
    cancelMock.mockResolvedValue(
      result({
        killed: 1,
        remaining: [5001],
        processes: [
          { pid: 4028, outcome: "terminated", reason: "sigterm" },
          { pid: 5001, outcome: "skipped", reason: "permission_denied" },
        ],
      }),
    );
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /终止会话并结束 1 个进程/ }));

    expect(await screen.findByText("已终止 1 个进程")).toBeInTheDocument();
    expect(screen.getByText("未退出进程：5001")).toBeInTheDocument();
    expect(screen.getByText("已跳过")).toBeInTheDocument();
    expect(screen.getByText("权限不足")).toBeInTheDocument();
    expect(await screen.findByText("会话任务已处理，但部分进程未终止")).toBeInTheDocument();
    expect(screen.queryByText("会话任务已终止")).not.toBeInTheDocument();
    expect(cancelMock).toHaveBeenCalledWith("user-1", "identity-1", [
      { pid: 4028, fingerprint: "fp-a" },
    ]);
  });

  it("E-07 reports an unsupported Worker and keeps confirmation disabled", async () => {
    previewMock.mockRejectedValue(new ApiError("unsupported", 409, 41007));
    renderDialog();

    expect(await screen.findByText("当前 Worker 不支持会话终止")).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
  });

  it("E-08 reports a changed process list and offers re-preview", async () => {
    previewMock.mockResolvedValue(preview());
    cancelMock.mockRejectedValue(new ApiError("stale", 409, 41009));
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /终止会话并结束 1 个进程/ }));
    expect(await screen.findByText("进程列表已变化，请重新预览")).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();

    previewMock.mockResolvedValueOnce(
      preview({ processes: [processRow({ pid: 4099, fingerprint: "fp-b" })] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "重新预览" }));

    await waitFor(() => expect(previewMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("进程列表已变化，请重新预览")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /终止会话并结束 1 个进程/ })).toBeEnabled();
  });

  it("E-09 shows a not-found banner when the session is gone", async () => {
    previewMock.mockResolvedValue(preview());
    cancelMock.mockRejectedValue(new ApiError("not found", 404, 41008));
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /终止会话并结束 1 个进程/ }));

    expect(await screen.findByText("会话或身份不存在")).toBeInTheDocument();
    expect(screen.queryByText("会话任务已终止")).not.toBeInTheDocument();
  });

  it("E-09 shows a failure banner when the termination RPC fails", async () => {
    previewMock.mockResolvedValue(preview());
    cancelMock.mockRejectedValue(new ApiError("failed", 502, 41010));
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /终止会话并结束 1 个进程/ }));

    expect(await screen.findByText("会话终止失败")).toBeInTheDocument();
    expect(screen.queryByText("会话任务已终止")).not.toBeInTheDocument();
  });

  it("E-10 sends only one cancel request while the confirmation is busy", async () => {
    previewMock.mockResolvedValue(preview());
    let resolveCancel!: (value: SessionCancelResultData) => void;
    cancelMock.mockImplementation(
      () =>
        new Promise<SessionCancelResultData>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    renderDialog();

    const button = await screen.findByRole("button", { name: /终止会话并结束/ });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(cancelMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button).toBeDisabled());

    await act(async () => {
      resolveCancel(result());
    });
    await waitFor(() => expect(button).toBeDisabled());
  });

  it("E-11 shows a load error with retry instead of an empty state", async () => {
    previewMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(preview());
    renderDialog();

    expect(await screen.findByText("读取会话运行状态失败")).toBeInTheDocument();
    expect(screen.queryByText("没有正在运行的任务或后台进程")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(previewMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("agent:john:wecom:direct:john")).toBeInTheDocument();
  });

  it("B-06 truncates the command line to 200 characters", () => {
    const longCmdline = `${"x".repeat(250)}TAIL-MARKER`;
    render(
      <ProcessPreviewTable
        processes={[processRow({ cmdline: longCmdline })]}
        skipped={{ notOwner: 0, envMismatch: 0, permissionDenied: 0 }}
      />,
    );

    expect(screen.getByText(`${"x".repeat(200)}…`)).toBeInTheDocument();
    expect(screen.queryByText(/TAIL-MARKER/)).not.toBeInTheDocument();
  });

  it("B-07 allows confirmation when the run is active but no process is listed", async () => {
    previewMock.mockResolvedValue(
      preview({ activeRun: { active: true, sessionId: "run-1" }, processes: [] }),
    );
    renderDialog();

    const button = await screen.findByRole("button", { name: /终止会话并结束 0 个进程/ });

    expect(button).toBeEnabled();
    expect(screen.getByText("将中止活跃 run。此操作不可撤销。")).toBeInTheDocument();

    cancelMock.mockResolvedValue(result({ killed: 0, processes: [] }));
    fireEvent.click(button);
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("user-1", "identity-1", []));
  });

  it("B-08 explains the skipped non-target process count", () => {
    render(
      <ProcessPreviewTable
        processes={[]}
        skipped={{ notOwner: 1, envMismatch: 2, permissionDenied: 0 }}
      />,
    );

    expect(screen.getByText("已跳过 3 个非目标进程")).toBeInTheDocument();
    expect(screen.getByText(/这些进程不属于目标会话/)).toBeInTheDocument();
  });
});
