import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLM } from "../src/pages/LLM";

const apiMocks = vi.hoisted(() => ({
  listLLMModels: vi.fn(),
  createLLMModels: vi.fn(),
  testLLMModels: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

const model = {
  modelConfigId: "model-a",
  displayName: "Alice Model",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  keyConfigured: true,
  keyFingerprint: "sha256:model-key",
  boundHumanUserId: "user-a",
  boundHumanUserName: "Alice User",
  createdAt: "2026-07-11T00:00:00Z",
  updatedAt: "2026-07-11T00:00:00Z",
};

const availableModel = {
  ...model,
  modelConfigId: "model-b",
  displayName: "Bob Model",
  keyFingerprint: "sha256:bob-key",
  boundHumanUserId: undefined,
  boundHumanUserName: undefined,
};

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.listLLMModels.mockResolvedValue({ items: [model, availableModel], total: 2 });
  apiMocks.createLLMModels.mockResolvedValue({
    items: [
      { ...availableModel, modelConfigId: "model-c", displayName: "Batch Model 1" },
      { ...availableModel, modelConfigId: "model-d", displayName: "Batch Model 2" },
    ],
    total: 2,
  });
  apiMocks.testLLMModels.mockResolvedValue({
    results: [{ modelConfigId: "model-a", displayName: "Alice Model", ok: true }],
  });
});

describe("LLM", () => {
  it("shows model fingerprints without exposing API keys", async () => {
    render(<LLM />);

    expect(await screen.findByText("Alice Model")).toBeInTheDocument();
    expect(screen.getByText("sha256:model-key")).toBeInTheDocument();
    expect(screen.getByText("Alice User")).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/sk-/)).not.toBeInTheDocument();
  });

  it("creates model configs from form fields and multiline API keys", async () => {
    render(<LLM />);
    await screen.findByText("Alice Model");
    expect(screen.queryByLabelText("API Key 列表")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建模型" }));
    expect(await screen.findByText("批量创建模型配置")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("显示名称"), {
      target: { value: "Batch Model" },
    });
    fireEvent.change(screen.getByLabelText("API Key 列表"), {
      target: { value: "sk-one\nsk-two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(apiMocks.createLLMModels).toHaveBeenCalledWith([
        {
          displayName: "Batch Model 1",
          provider: "deepseek",
          model: "deepseek-chat",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-one",
        },
        {
          displayName: "Batch Model 2",
          provider: "deepseek",
          model: "deepseek-chat",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-two",
        },
      ]),
    );
  });

  it("tests selected model configs in batch", async () => {
    render(<LLM />);
    await screen.findByText("Alice Model");
    fireEvent.click(screen.getByRole("checkbox", { name: "选择模型 Alice Model" }));
    fireEvent.click(screen.getByRole("button", { name: "批量测试连通性" }));

    await waitFor(() => expect(apiMocks.testLLMModels).toHaveBeenCalledWith(["model-a"]));
    expect(await screen.findByText("通过")).toBeInTheDocument();
  });

  it("filters model configs from the list toolbar", async () => {
    render(<LLM />);
    expect(await screen.findByText("Alice Model")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索模型配置"), {
      target: { value: "bob" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询模型配置" }));

    expect(screen.getByText("Bob Model")).toBeInTheDocument();
    expect(screen.queryByText("Alice Model")).not.toBeInTheDocument();
  });
});
