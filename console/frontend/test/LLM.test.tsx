import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pod } from "../src/api";
import { LLM } from "../src/pages/LLM";

const apiMocks = vi.hoisted(() => ({
  getLLM: vi.fn(),
  setLLM: vi.fn(),
  testLLM: vi.fn(),
  listPods: vi.fn(),
  getPodLLM: vi.fn(),
  setPodLLM: vi.fn(),
  applyLLM: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

const pod: Pod = {
  podId: "pod-a",
  displayName: "Pod A",
  imageTag: "muad:test",
  state: "running",
  channels: ["wecom"],
  modelOverride: { keyConfigured: false },
  maxUsers: 10,
  userCount: 1,
  availableSlots: 9,
  configGeneration: 2,
  appliedGeneration: 2,
  generationLag: 0,
  lastApplyStatus: "applied",
  serviceTokenFingerprint: "sha256:service",
  cpuPercent: 0,
  memMiB: 0,
  skillActive: 0,
  skillQueued: 0,
  browserActive: 0,
  browserQueued: 0,
  runtimeGuardHealthy: true,
  createdAt: "2026-07-11T00:00:00Z",
  updatedAt: "2026-07-11T00:00:00Z",
};

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.getLLM.mockResolvedValue({
    configured: true,
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    apiKeyConfigured: true,
    keyFingerprint: "sha256:global-key",
  });
  apiMocks.setLLM.mockResolvedValue({
    configured: true,
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    apiKeyConfigured: true,
    keyFingerprint: "sha256:global-key",
  });
  apiMocks.testLLM.mockResolvedValue({ ok: true });
  apiMocks.listPods.mockResolvedValue({ items: [pod], total: 1, page: 1, pageSize: 100 });
  apiMocks.getPodLLM.mockResolvedValue({
    podId: "pod-a",
    configured: false,
    modelOverride: { keyConfigured: false },
  });
  apiMocks.setPodLLM.mockResolvedValue({
    podId: "pod-a",
    configured: false,
    modelOverride: { keyConfigured: false },
  });
  apiMocks.applyLLM.mockResolvedValue({ results: { "pod-a": "queued" } });
});

describe("LLM", () => {
  it("shows only the global key fingerprint and keeps the key field blank", async () => {
    render(<LLM />);

    expect(await screen.findByText(/sha256:global-key/)).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(screen.queryByDisplayValue(/sk-/)).not.toBeInTheDocument();
  });

  it("preserves an existing key when saving a blank key field", async () => {
    render(<LLM />);
    await screen.findByText(/sha256:global-key/);
    fireEvent.click(screen.getByRole("button", { name: "保存全局配置" }));

    await waitFor(() =>
      expect(apiMocks.setLLM).toHaveBeenCalledWith({
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
      }),
    );
  });

  it("applies the global model to selected Pods", async () => {
    render(<LLM />);
    await screen.findByText("Pod A (pod-a)");
    fireEvent.click(screen.getByRole("checkbox", { name: "Pod A (pod-a)" }));
    fireEvent.click(screen.getByRole("button", { name: "应用到所选 Pod" }));

    await waitFor(() => expect(apiMocks.applyLLM).toHaveBeenCalledWith(["pod-a"]));
  });
});
