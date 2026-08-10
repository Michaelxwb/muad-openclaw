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
  apiKey: "sk-model-key",
  lastTestAt: "2026-07-11T00:00:00Z",
  lastTestOK: true,
  lastTestError: "",
  boundHumanUserId: "user-a",
  boundHumanUserName: "Alice User",
  createdAt: "2026-07-11T00:00:00Z",
  updatedAt: "2026-07-11T00:00:00Z",
};

const availableModel = {
  ...model,
  modelConfigId: "model-b",
  displayName: "Bob Model",
  apiKey: "sk-bob-key",
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
  it("shows plaintext API keys and test results", async () => {
    render(<LLM />);

    expect(await screen.findByText("Alice Model")).toBeInTheDocument();
    expect(screen.getByText("sk-model-key")).toBeInTheDocument();
    expect(screen.getByText("Alice User")).toBeInTheDocument();
    expect(screen.getAllByText("通过").length).toBeGreaterThan(0);
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
          supportsTools: true,
        },
        {
          displayName: "Batch Model 2",
          provider: "deepseek",
          model: "deepseek-chat",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-two",
          supportsTools: true,
        },
      ]),
    );
  });

  it("allows unchecking supportsTools in the create dialog", async () => {
    render(<LLM />);
    await screen.findByText("Alice Model");
    fireEvent.click(screen.getByRole("button", { name: "创建模型" }));
    await screen.findByText("批量创建模型配置");

    const supportsTools = screen.getByRole("checkbox", { name: /支持函数调用/ });
    expect(supportsTools).toBeChecked();

    fireEvent.click(supportsTools);
    await waitFor(() => expect(supportsTools).not.toBeChecked());

    fireEvent.change(screen.getByLabelText("显示名称"), {
      target: { value: "Batch Model" },
    });
    fireEvent.change(screen.getByLabelText("API Key 列表"), {
      target: { value: "sk-one" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(apiMocks.createLLMModels).toHaveBeenCalledWith([
        expect.objectContaining({ displayName: "Batch Model 1", supportsTools: false }),
      ]),
    );
  });

  it("tests selected model configs in batch", async () => {
    render(<LLM />);
    await screen.findByText("Alice Model");
    fireEvent.click(screen.getByRole("checkbox", { name: "选择模型 Alice Model" }));
    fireEvent.click(screen.getByRole("button", { name: "批量测试连通性" }));

    await waitFor(() => expect(apiMocks.testLLMModels).toHaveBeenCalledWith(["model-a"]));
    expect(await screen.findAllByText("通过")).not.toHaveLength(0);
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

  it("supportsTools checkbox must not be label-wrapped (label activation double-fires onChange)", async () => {
    render(<LLM />);
    await screen.findByText("Alice Model");
    fireEvent.click(screen.getByRole("button", { name: "创建模型" }));
    await screen.findByText("批量创建模型配置");

    const supportsTools = screen.getByRole("checkbox", { name: /支持函数调用/ });
    // 回归：Field 用 <label> 包裹 checkbox 时，Chrome 中 label 激活会向 input 再转发
    // 一次合成 click → handleChange 两次 → 勾选被立刻抵消。必须用非 label 容器。
    expect(supportsTools.closest("label")).toBeNull();
  });
});
