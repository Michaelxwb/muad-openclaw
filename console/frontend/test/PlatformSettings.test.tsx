import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Toast } from "@douyinfe/semi-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../src/api";
import { ApiError } from "../src/api";
import { PlatformSettings } from "../src/components/platforms/PlatformSettings";

const apiMocks = vi.hoisted(() => ({
  listPlatforms: vi.fn(),
  createPlatform: vi.fn(),
  patchPlatform: vi.fn(),
  deletePlatform: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

const xdr: Platform = {
  platform: "xdr",
  displayName: "XDR",
  enabled: true,
  updatedAt: "2026-07-11T00:00:00Z",
};

const sdsp: Platform = {
  platform: "sdsp",
  displayName: "SDSP",
  enabled: false,
  updatedAt: "2026-07-11T00:00:00Z",
};

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.listPlatforms.mockResolvedValue({ items: [xdr], total: 1 });
  apiMocks.createPlatform.mockResolvedValue(xdr);
  apiMocks.patchPlatform.mockResolvedValue(xdr);
  apiMocks.deletePlatform.mockResolvedValue({
    platform: "xdr",
    deleted: true,
    affectedPodIds: ["pod-a"],
  });
});

afterEach(() => Toast.destroyAll());

describe("PlatformSettings", () => {
  it("lists platform state without default adapter or config fields", async () => {
    render(<PlatformSettings />);

    expect(await screen.findByText("XDR")).toBeInTheDocument();
    expect(screen.getByText("xdr")).toBeInTheDocument();
    expect(screen.getByText("已启用")).toBeInTheDocument();
    expect(screen.queryByText("sha256:xdr-config")).not.toBeInTheDocument();
  });

  it("adds a platform with only its ID and display name", async () => {
    render(<PlatformSettings />);
    await screen.findByText("XDR");
    fireEvent.click(screen.getByRole("button", { name: "增加平台" }));
    expect(document.querySelector(".standard-modal")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("业务平台"), { target: { value: "soar" } });
    fireEvent.change(screen.getByLabelText("平台显示名称"), { target: { value: "SOAR" } });
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() =>
      expect(apiMocks.createPlatform).toHaveBeenCalledWith({
        platform: "soar",
        displayName: "SOAR",
        enabled: true,
      }),
    );
  });

  it("shows platform validation details returned by the backend", async () => {
    apiMocks.createPlatform.mockRejectedValueOnce(
      new ApiError("业务平台数据不合法", 400, 40607, "platform 必须以小写字母开头"),
    );
    render(<PlatformSettings />);
    await screen.findByText("XDR");
    fireEvent.click(screen.getByRole("button", { name: "增加平台" }));
    fireEvent.change(screen.getByLabelText("业务平台"), { target: { value: "XDR" } });
    fireEvent.change(screen.getByLabelText("平台显示名称"), { target: { value: "XDR" } });

    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    expect(await screen.findByText("技术详情")).toBeInTheDocument();
    expect(screen.getByText(/platform 必须/)).toBeInTheDocument();
  });

  it("filters platforms from the list toolbar", async () => {
    apiMocks.listPlatforms.mockResolvedValueOnce({ items: [xdr, sdsp], total: 2 });
    render(<PlatformSettings />);
    expect(await screen.findByText("XDR")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索业务平台"), {
      target: { value: "sdsp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询业务平台" }));

    expect(screen.getByText("SDSP")).toBeInTheDocument();
    expect(screen.queryByText("XDR")).not.toBeInTheDocument();
  });

  it("edits and disables an existing platform", async () => {
    render(<PlatformSettings />);
    await screen.findByText("XDR");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("switch", { name: "平台启用状态" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() =>
      expect(apiMocks.patchPlatform).toHaveBeenCalledWith("xdr", {
        displayName: "XDR",
        enabled: false,
      }),
    );
  });

  it("deletes a platform after confirmation", async () => {
    render(<PlatformSettings />);
    await screen.findByText("XDR");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(await screen.findByText("删除 XDR")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() => expect(apiMocks.deletePlatform).toHaveBeenCalledWith("xdr"));
  });
});
