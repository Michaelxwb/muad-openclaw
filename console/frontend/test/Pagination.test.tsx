import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PageSizeSelect,
  renderTablePagination,
  tablePagination,
} from "../src/components/Pagination";

describe("Pagination", () => {
  it("keeps page size choices explicit and shared", () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([10, 20, 50, 100]);
    expect(DEFAULT_PAGE_SIZE).toBe(10);

    const pagination = tablePagination({
      page: 1,
      pageSize: 20,
      total: 46,
      onPageChange: vi.fn(),
      onPageSizeChange: vi.fn(),
    });

    expect(pagination).not.toBe(false);
    if (pagination === false) return;
    expect(pagination.pageSizeOpts).toEqual([10, 20, 50, 100]);
    expect(pagination.showSizeChanger).toBe(false);
  });

  it("renders the visible page size selector", () => {
    render(<PageSizeSelect pageSize={20} onPageSizeChange={vi.fn()} />);

    expect(screen.getByText("每页")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByText("条")).toBeInTheDocument();
  });

  it("places page size selector before page navigation in table pagination", () => {
    const pagination = tablePagination({
      page: 1,
      pageSize: 20,
      total: 46,
      onPageChange: vi.fn(),
      onPageSizeChange: vi.fn(),
    });
    if (pagination === false) return;

    render(<>{renderTablePagination(pagination)}</>);

    const selector = screen.getByRole("combobox");
    const pageInfo = screen.getByText("1/3");
    expect(selector.compareDocumentPosition(pageInfo) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
