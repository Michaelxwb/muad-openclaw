import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Modal } from "@douyinfe/semi-ui";
import { BatchToolbar } from "../src/components/BatchToolbar";

describe("BatchToolbar", () => {
  it("confirms batch upgrade with selected count", () => {
    const onBatchUpgrade = vi.fn();
    const confirm = vi.spyOn(Modal, "confirm").mockImplementation((config) => {
      expect(config.content).toContain("2 个");
      config.onOk?.();
      return {} as ReturnType<typeof Modal.confirm>;
    });
    render(
      <BatchToolbar
        selectedIds={["alice", "bob"]}
        onBatchUpgrade={onBatchUpgrade}
        onBatchDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "批量升级" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onBatchUpgrade).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it("does not show selected count in delete button text", () => {
    render(
      <BatchToolbar
        selectedIds={["alice", "bob"]}
        onBatchUpgrade={vi.fn()}
        onBatchDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "批量删除" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /批量删除 \(/ })).not.toBeInTheDocument();
  });

  it("confirms batch delete with count only", () => {
    const warning = vi.spyOn(Modal, "warning").mockImplementation((config) => {
      expect(config.content).toBe("确定删除 2 个已勾选 Pod？此操作不可撤销。");
      expect(config.content).not.toContain("alice");
      expect(config.content).not.toContain("bob");
      return {} as ReturnType<typeof Modal.warning>;
    });
    render(
      <BatchToolbar
        selectedIds={["alice", "bob"]}
        onBatchUpgrade={vi.fn()}
        onBatchDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "批量删除" }));
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });
});
