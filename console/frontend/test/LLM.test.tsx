import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLM, MODEL_TABLE_COLUMN_WIDTHS } from "../src/pages/LLM";

const apiMocks = vi.hoisted(() => ({
  listLLMModels: vi.fn(),
  createLLMModels: vi.fn(),
  testLLMModels: vi.fn(),
  updateLLMModel: vi.fn(),
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
  supportsTools: true,
  supportsImages: false,
  thinking: "off",
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
  supportsTools: false,
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
  apiMocks.updateLLMModel.mockResolvedValue({
    ...model,
    thinking: "high",
    supportsTools: false,
    apiKey: "sk-updated",
  });
});

describe("LLM", () => {
  it("shows plaintext API keys and test results", async () => {
    render(<LLM />);

    expect(await screen.findByText("Alice Model")).toBeInTheDocument();
    expect(screen.getByText("sk-model-key")).toBeInTheDocument();
    expect(screen.getByText("Alice User")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "模型能力" })).toBeInTheDocument();
    expect(screen.getByText("工具调用")).toBeInTheDocument();
    expect(screen.getByText("不支持")).toBeInTheDocument();
    expect(screen.getAllByText("通过").length).toBeGreaterThan(0);
  });

  it("keeps model columns compact enough to fit without horizontal table scrolling", async () => {
    render(<LLM />);

    expect(await screen.findByText("Alice Model")).toBeInTheDocument();
    const modelTable = screen.getByRole("grid");
    expect(modelTable.getAttribute("style") ?? "").not.toContain("width: 100%");
    expect(modelTable.closest(".semi-table-wrapper")?.getAttribute("style") ?? "").not.toContain(
      "--model-table-min-width",
    );
    expect(Object.values(MODEL_TABLE_COLUMN_WIDTHS).reduce((sum, width) => sum + width, 0)).toBe(
      1460,
    );
  });

  // S-12 [integration] 真实边界：组件真实渲染（真实 fixture 数据，不 mock 组件）。
  // 四种能力组合必须在同一列里可区分——这是「数据不合并」的直接体现。
  it("renders the capability column for all four combinations", async () => {
    const matrix = [
      { key: "both", tools: true, images: true },
      { key: "tools", tools: true, images: false },
      { key: "images", tools: false, images: true },
      { key: "none", tools: false, images: false },
    ];
    apiMocks.listLLMModels.mockResolvedValue({
      items: matrix.map((entry) => ({
        ...model,
        modelConfigId: `model-${entry.key}`,
        displayName: `Model ${entry.key}`,
        supportsTools: entry.tools,
        supportsImages: entry.images,
        boundHumanUserId: undefined,
        boundHumanUserName: undefined,
      })),
      total: matrix.length,
    });

    render(<LLM />);
    expect(await screen.findByText("Model both")).toBeInTheDocument();
    const rowFor = (name: string) => {
      const cell = screen.getByText(name).closest("tr");
      expect(cell).not.toBeNull();
      return cell as HTMLElement;
    };

    const both = rowFor("Model both");
    expect(within(both).getByText("工具调用")).toBeInTheDocument();
    expect(within(both).getByText("文本+图片")).toBeInTheDocument();

    const toolsOnly = rowFor("Model tools");
    expect(within(toolsOnly).getByText("工具调用")).toBeInTheDocument();
    expect(within(toolsOnly).queryByText("文本+图片")).not.toBeInTheDocument();

    const imagesOnly = rowFor("Model images");
    expect(within(imagesOnly).getByText("文本+图片")).toBeInTheDocument();
    expect(within(imagesOnly).queryByText("工具调用")).not.toBeInTheDocument();

    const neither = rowFor("Model none");
    expect(within(neither).getByText("不支持")).toBeInTheDocument();
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
          supportsImages: false,
          thinking: "off",
        },
        {
          displayName: "Batch Model 2",
          provider: "deepseek",
          model: "deepseek-chat",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-two",
          supportsTools: true,
          supportsImages: false,
          thinking: "off",
        },
      ]),
    );
  });

  it("allows unchecking supportsTools in the create dialog", async () => {
    render(<LLM />);
    await screen.findByText("Alice Model");
    fireEvent.click(screen.getByRole("button", { name: "创建模型" }));
    await screen.findByText("批量创建模型配置");

    const supportsTools = screen.getByRole("checkbox", { name: /工具调用/ });
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

    const supportsTools = screen.getByRole("checkbox", { name: /工具调用/ });
    // 回归：Field 用 <label> 包裹 checkbox 时，Chrome 中 label 激活会向 input 再转发
    // 一次合成 click → handleChange 两次 → 勾选被立刻抵消。必须用非 label 容器。
    expect(supportsTools.closest("label")).toBeNull();
  });

  it("edits apiKey, supportsTools, and thinking from the edit dialog", async () => {
    render(<LLM />);
    await screen.findByText("Alice Model");

    fireEvent.click(screen.getByRole("button", { name: "编辑模型 Alice Model" }));
    await screen.findByText("编辑模型配置 Alice Model");

    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-updated" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /工具调用/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(apiMocks.updateLLMModel).toHaveBeenCalledWith("model-a", {
        apiKey: "sk-updated",
        supportsTools: false,
        supportsImages: false,
        thinking: "off",
      }),
    );
    expect(await screen.findByText("模型配置已更新")).toBeInTheDocument();
  });

  // S-13 [unit] 真实边界：两个对话框组件真实实现。
  it("defaults image capability off and keeps tools on in the create dialog", async () => {
    render(<LLM />);
    await screen.findByText("Alice Model");

    fireEvent.click(screen.getByRole("button", { name: "创建模型" }));
    await screen.findByText("批量创建模型配置");

    expect(screen.getByRole("checkbox", { name: /文本\+图片/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /工具调用/ })).toBeChecked();
  });

  it("reflects the saved image capability when editing a model", async () => {
    apiMocks.listLLMModels.mockResolvedValueOnce({
      items: [{ ...model, supportsImages: true }, availableModel],
      total: 2,
    });
    render(<LLM />);
    await screen.findByText("Alice Model");

    fireEvent.click(screen.getByRole("button", { name: "编辑模型 Alice Model" }));
    await screen.findByText("编辑模型配置 Alice Model");

    expect(screen.getByRole("checkbox", { name: /文本\+图片/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /工具调用/ })).toBeChecked();
  });

  // E-12 / RISK-F02 [unit] 真实边界：对话框真实 DOM。
  // `Field` 若以 <label> 包裹 checkbox，label 激活与 input 事件会双触发 onChange。
  it("fires onChange once for the image checkbox and never wraps it in a label", async () => {
    const onChange = vi.fn();
    render(<LLM />);
    await screen.findByText("Alice Model");
    fireEvent.click(screen.getByRole("button", { name: "创建模型" }));
    await screen.findByText("批量创建模型配置");

    const imageCheckbox = screen.getByRole("checkbox", { name: /文本\+图片/ });
    imageCheckbox.addEventListener("change", onChange);
    fireEvent.click(imageCheckbox);

    await waitFor(() => expect(imageCheckbox).toBeChecked());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(imageCheckbox.closest("label")).toBeNull();
  });

  // S-11 [integration] 保存后的 PATCH 载荷与列表重渲染。
  // ⚠️ 边界偏差（已记录并待用户确认）：design 把 S-11 定为 E2E 且要求不得 mock
  // `api.ts` service 层，但本项目 vitest 在模块级替身 `src/api`，无浏览器/MSW 基础设施。
  // 此处断言对话框真实构造出的请求载荷 + 页面真实重渲染，属降级后的 integration。
  it("sends supportsImages and refreshes the capability column after saving", async () => {
    apiMocks.listLLMModels
      .mockResolvedValueOnce({ items: [model, availableModel], total: 2 })
      .mockResolvedValueOnce({
        items: [{ ...model, supportsImages: true }, availableModel],
        total: 2,
      });
    render(<LLM />);
    await screen.findByText("Alice Model");

    fireEvent.click(screen.getByRole("button", { name: "编辑模型 Alice Model" }));
    await screen.findByText("编辑模型配置 Alice Model");
    fireEvent.click(screen.getByRole("checkbox", { name: /文本\+图片/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(apiMocks.updateLLMModel).toHaveBeenCalledWith(
        "model-a",
        expect.objectContaining({ supportsImages: true }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("编辑模型配置 Alice Model")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("文本+图片")).toBeInTheDocument();
  });

  // E-11 [integration] `api.ts` 真实错误路径 → UI。
  it("keeps the edit dialog open and reports the error when saving fails", async () => {
    apiMocks.updateLLMModel.mockRejectedValueOnce(new Error("boom"));
    render(<LLM />);
    await screen.findByText("Alice Model");

    fireEvent.click(screen.getByRole("button", { name: "编辑模型 Alice Model" }));
    await screen.findByText("编辑模型配置 Alice Model");
    fireEvent.click(screen.getByRole("checkbox", { name: /文本\+图片/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(apiMocks.updateLLMModel).toHaveBeenCalled());
    // 对话框保持打开、勾选状态不丢失（可重试）
    expect(await screen.findByText("编辑模型配置 Alice Model")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /文本\+图片/ })).toBeChecked();
  });
});
