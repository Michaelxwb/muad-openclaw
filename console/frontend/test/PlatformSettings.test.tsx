import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Toast } from "@douyinfe/semi-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../src/api";
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
  config: { baseUrl: "https://xdr.internal" },
  configFingerprint: "sha256:xdr-config",
  enabled: true,
  adapterInstalled: true,
  updatedAt: "2026-07-11T00:00:00Z",
};

const sdsp: Platform = {
  platform: "sdsp",
  displayName: "SDSP",
  config: { baseUrl: "https://sdsp.internal" },
  configFingerprint: "sha256:sdsp-config",
  enabled: false,
  adapterInstalled: true,
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
  it("lists platform state, adapter state, and configuration fingerprint", async () => {
    render(<PlatformSettings />);

    expect(await screen.findByText("sha256:xdr-config")).toBeInTheDocument();
    expect(screen.getByText("已启用")).toBeInTheDocument();
    expect(screen.queryByText("Adapter 缺失")).not.toBeInTheDocument();
  });

  it("adds an installed platform with a minimal JSON configuration", async () => {
    render(<PlatformSettings />);
    await screen.findByText("sha256:xdr-config");
    fireEvent.click(screen.getByRole("button", { name: "增加平台" }));
    expect(document.querySelector(".standard-modal")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "平台配置 JSON" }), {
      target: { value: '{"baseUrl":"https://soar.internal"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() =>
      expect(apiMocks.createPlatform).toHaveBeenCalledWith({
        platform: "soar",
        displayName: "SOAR",
        config: { baseUrl: "https://soar.internal" },
        enabled: true,
      }),
    );
  });

  it("filters platforms from the list toolbar", async () => {
    apiMocks.listPlatforms.mockResolvedValueOnce({ items: [xdr, sdsp], total: 2 });
    render(<PlatformSettings />);
    expect(await screen.findByText("sha256:xdr-config")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索业务平台"), {
      target: { value: "sdsp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询业务平台" }));

    expect(screen.getByText("sha256:sdsp-config")).toBeInTheDocument();
    expect(screen.queryByText("sha256:xdr-config")).not.toBeInTheDocument();
  });

  it("edits and disables an existing platform", async () => {
    render(<PlatformSettings />);
    await screen.findByText("sha256:xdr-config");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("switch", { name: "平台启用状态" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() =>
      expect(apiMocks.patchPlatform).toHaveBeenCalledWith("xdr", {
        displayName: "XDR",
        config: { baseUrl: "https://xdr.internal" },
        enabled: false,
      }),
    );
  });

  it("deletes a platform after confirmation", async () => {
    render(<PlatformSettings />);
    await screen.findByText("sha256:xdr-config");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(await screen.findByText("删除 XDR")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() => expect(apiMocks.deletePlatform).toHaveBeenCalledWith("xdr"));
  });
});
