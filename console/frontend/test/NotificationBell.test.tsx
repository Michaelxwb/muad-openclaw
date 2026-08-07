import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell, requestAlertsRefresh } from "../src/components/NotificationBell";

const alertsMock = vi.hoisted(() => vi.fn());

beforeEach(() => alertsMock.mockReset());

describe("NotificationBell", () => {
  it("shows Pod generation and queue-capacity alert details", async () => {
    alertsMock.mockResolvedValue([
      {
        podId: "pod-a",
        level: "P2",
        kind: "generation_lag",
        message: "runtime configuration has not converged",
        details: {
          generation: 4,
          appliedGeneration: 2,
          queued: 3,
          limit: 1,
          error: "runtime apply validate failed",
        },
      },
    ]);
    render(<NotificationBell loadAlerts={alertsMock} />);
    await screen.findByText("1");
    fireEvent.click(screen.getByRole("button", { name: "告警" }));

    expect(screen.getByText("pod-a")).toBeInTheDocument();
    expect(screen.getByText(/期望 4/)).toBeInTheDocument();
    expect(screen.getByText(/已应用 2/)).toBeInTheDocument();
    expect(screen.getByText(/排队 3/)).toBeInTheDocument();
    expect(screen.getByText(/上限 1/)).toBeInTheDocument();
    expect(screen.getByText(/错误 runtime apply validate failed/)).toBeInTheDocument();
  });

  it("refreshes alerts when application code requests a bell refresh", async () => {
    alertsMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        podId: "pod-b",
        level: "P1",
        kind: "config_apply_failed",
        message: "runtime configuration apply failed",
        details: { error: "missing model-visible Skills: policy-check" },
      },
    ]);
    render(<NotificationBell loadAlerts={alertsMock} />);
    await waitFor(() => expect(alertsMock).toHaveBeenCalledTimes(1));

    requestAlertsRefresh();

    await waitFor(() => expect(alertsMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "告警" }));
    expect(screen.getByText("pod-b")).toBeInTheDocument();
    expect(screen.getByText(/policy-check/)).toBeInTheDocument();
  });

  it("surfaces alert loading failures instead of silently swallowing them", async () => {
    alertsMock.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("alerts unavailable"));
    render(<NotificationBell loadAlerts={alertsMock} />);
    fireEvent.click(screen.getByRole("button", { name: "告警" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新告警" }));

    expect(await screen.findByText("加载告警失败")).toBeInTheDocument();
  });
});
