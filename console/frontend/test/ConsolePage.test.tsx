import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Toast } from "@douyinfe/semi-ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackBanner, ListToolbar, setRepeatableError } from "../src/components/ConsolePage";

afterEach(() => {
  Toast.destroyAll();
  vi.useRealTimers();
});

describe("FeedbackBanner", () => {
  it("shows success feedback as an auto-dismiss toast instead of an inline banner", async () => {
    const view = render(<FeedbackBanner message="保存成功" />);

    expect(view.container).toBeEmptyDOMElement();
    expect(await screen.findByText("保存成功")).toBeInTheDocument();
  });

  it("shows error feedback as an auto-dismiss toast instead of an inline banner", async () => {
    const view = render(<FeedbackBanner error="保存失败" />);

    expect(view.container).toBeEmptyDOMElement();
    expect(await screen.findByText("保存失败")).toBeInTheDocument();
  });

  it("emits a fresh state change for repeated validation errors", () => {
    vi.useFakeTimers();
    const values: string[] = [];

    setRepeatableError((value) => values.push(String(value)), "Pod ID 必填");
    vi.runAllTimers();

    expect(values).toEqual(["", "Pod ID 必填"]);
  });
});

describe("ListToolbar", () => {
  it("renders actions before filters for consistent list headers", () => {
    render(<ListToolbar actions={<button>创建</button>} filters={<input aria-label="搜索" />} />);

    const action = screen.getByRole("button", { name: "创建" });
    const filter = screen.getByLabelText("搜索");
    expect(action.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
