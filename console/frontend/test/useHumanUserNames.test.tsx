import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHumanUserNames } from "../src/hooks/useHumanUserNames";

const apiMocks = vi.hoisted(() => ({
  listAllHumanUsers: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

function userRow(humanUserId: string, displayName: string) {
  return { humanUserId, displayName };
}

describe("useHumanUserNames", () => {
  beforeEach(() => {
    apiMocks.listAllHumanUsers.mockReset();
  });

  it("pages through all users so names beyond the first page resolve", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      userRow(`user-${index}`, `用户${index}`),
    );
    apiMocks.listAllHumanUsers
      .mockResolvedValueOnce({ items: firstPage, total: 101, page: 1, pageSize: 100 })
      .mockResolvedValueOnce({
        items: [userRow("11e96509-1c82-4db1-ba8a-23635c121268", "林海(10636)")],
        total: 101,
        page: 2,
        pageSize: 100,
      });

    const { result } = renderHook(() => useHumanUserNames(true));

    await waitFor(() => expect(result.current.size).toBe(101));
    expect(result.current.get("11e96509-1c82-4db1-ba8a-23635c121268")).toBe("林海(10636)");
    expect(apiMocks.listAllHumanUsers).toHaveBeenCalledTimes(2);
    expect(apiMocks.listAllHumanUsers).toHaveBeenNthCalledWith(1, { page: 1, pageSize: 100 });
    expect(apiMocks.listAllHumanUsers).toHaveBeenNthCalledWith(2, { page: 2, pageSize: 100 });
  });

  it("stops paging when a page returns no items", async () => {
    apiMocks.listAllHumanUsers
      .mockResolvedValueOnce({
        items: [userRow("user-0", "用户0")],
        total: 5,
        page: 1,
        pageSize: 100,
      })
      .mockResolvedValueOnce({ items: [], total: 5, page: 2, pageSize: 100 });

    const { result } = renderHook(() => useHumanUserNames(true));

    await waitFor(() => expect(result.current.get("user-0")).toBe("用户0"));
    expect(apiMocks.listAllHumanUsers).toHaveBeenCalledTimes(2);
  });

  it("keeps the caller-side id fallback when the lookup fails", async () => {
    apiMocks.listAllHumanUsers.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useHumanUserNames(true));

    await waitFor(() => expect(apiMocks.listAllHumanUsers).toHaveBeenCalledTimes(1));
    expect(result.current.size).toBe(0);
  });
});
