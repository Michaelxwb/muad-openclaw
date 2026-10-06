import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PodUpgradeDialog } from "../src/pages/containers/PodUpgradeDialog";

const apiMocks = vi.hoisted(() => ({ upgrade: vi.fn() }));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

describe("PodUpgradeDialog 跨版本迁移 opt-out", () => {
  beforeEach(() => {
    apiMocks.upgrade.mockReset();
    apiMocks.upgrade.mockResolvedValue({
      podId: "pod-a",
      imageTag: "img:new",
      state: "running",
      configGeneration: 1,
      appliedGeneration: 1,
    });
  });

  it("默认不勾选：请求不带 allowRollback（保持既有回滚语义）", async () => {
    const onClose = vi.fn();
    render(
      <PodUpgradeDialog
        podIds={["pod-a"]}
        onClose={onClose}
        onDone={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const input = await screen.findByLabelText("升级镜像 tag");
    expect(screen.getByLabelText("跨版本迁移（失败不自动回退）")).not.toBeChecked();
    fireEvent.change(input, { target: { value: "img:new" } });
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    await waitFor(() =>
      expect(apiMocks.upgrade).toHaveBeenCalledWith("pod-a", "img:new", undefined),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("勾选跨版本迁移：透传 allowRollback=false 并展示不可逆提示", async () => {
    render(
      <PodUpgradeDialog
        podIds={["pod-a"]}
        onClose={vi.fn()}
        onDone={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const input = await screen.findByLabelText("升级镜像 tag");
    fireEvent.change(input, { target: { value: "img:new" } });
    fireEvent.click(screen.getByLabelText("跨版本迁移（失败不自动回退）"));
    expect(
      screen.getByText("迁移不可逆：失败将停在 error 等待人工修复，不会自动回滚旧镜像。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    await waitFor(() => expect(apiMocks.upgrade).toHaveBeenCalledWith("pod-a", "img:new", false));
  });
});
