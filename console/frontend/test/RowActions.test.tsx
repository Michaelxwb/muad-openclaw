import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RowActions } from "../src/components/RowActions";
import type { Container } from "../src/api";

const baseContainer: Container = {
  userId: "alice",
  channels: ["wecom"],
  channelStatuses: { wecom: { connected: true } },
  state: "running",
  imageTag: "img:test",
  cpuPercent: 0,
  memMiB: 0,
  memLimit: "",
  cpuLimit: "",
  restartPolicy: "",
};

function renderActions(container: Container) {
  render(
    <RowActions
      container={container}
      actions={[]}
      onViewLogs={vi.fn()}
      onOpenQr={vi.fn()}
      onEditChannels={vi.fn()}
      onOpenResources={vi.fn()}
      onAction={vi.fn()}
    />,
  );
}

describe("RowActions", () => {
  it("hides QR action for non-WeChat containers", () => {
    renderActions(baseContainer);
    expect(screen.queryByRole("button", { name: "扫码" })).not.toBeInTheDocument();
  });

  it("shows QR action for WeChat containers", () => {
    renderActions({ ...baseContainer, channels: ["wecom", "wechat"] });
    expect(screen.getByRole("button", { name: "扫码" })).toBeInTheDocument();
  });
});
