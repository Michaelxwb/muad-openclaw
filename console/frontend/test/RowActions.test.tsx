import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RowActions } from "../src/components/RowActions";
import type { Pod } from "../src/api";

const basePod: Pod = {
  podId: "pod-a",
  displayName: "Pod A",
  channels: ["wecom"],
  channelStatuses: { wecom: true },
  state: "running",
  imageTag: "img:test",
  maxUsers: 10,
  userCount: 1,
  availableSlots: 9,
  configGeneration: 1,
  appliedGeneration: 1,
  generationLag: 0,
  skillsPending: false,
  lastApplyStatus: "applied",
  serviceTokenFingerprint: "sha256:test",
  cpuPercent: 0,
  cpuMills: 0,
  cpuLimitCores: "0",
  memMiB: 0,
  memLimitMiB: 0,
  skillActive: 0,
  skillQueued: 0,
  browserActive: 0,
  browserQueued: 0,
  runtimeGuardHealthy: true,
  createdAt: "2026-07-11T00:00:00Z",
  updatedAt: "2026-07-11T00:00:00Z",
};

function renderActions(pod: Pod) {
  render(
    <RowActions
      pod={pod}
      actions={[]}
      onViewLogs={vi.fn()}
      onOpenQr={vi.fn()}
      onEdit={vi.fn()}
      onAction={vi.fn()}
    />,
  );
}

describe("RowActions", () => {
  it("hides QR action for non-WeChat containers", () => {
    renderActions(basePod);
    expect(screen.queryByRole("button", { name: "扫码" })).not.toBeInTheDocument();
  });

  it("shows QR action for WeChat containers", () => {
    renderActions({ ...basePod, channels: ["wecom", "wechat"] });
    expect(screen.getByRole("button", { name: "扫码" })).toBeInTheDocument();
  });
});
