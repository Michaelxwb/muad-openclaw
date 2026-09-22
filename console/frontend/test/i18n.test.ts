import { describe, expect, it } from "vitest";

import en from "../src/i18n/locales/en";
import zh from "../src/i18n/locales/zh";

// NFR-I18N-F01 [unit] 真实边界：两份 locale 文件的真实内容。
// key 结构一致性由 `const en: AppLocale` 在 tsc 层强制（漏 key 编译不过）；
// 这里补的是 tsc 查不出的值层问题：key 在但值为空串、或中文侧未更新。
describe("模型能力 i18n 文案", () => {
  it("zh/en 均提供模型能力相关 key 且值非空", () => {
    for (const [name, locale] of [["zh", zh], ["en", en]] as const) {
      const model = locale.model as unknown as Record<string, string>;
      for (const key of ["capabilities", "imageInput", "imageInputAria"]) {
        expect(model[key], `${name}.model.${key} 缺失或为空`).toBeTruthy();
      }
    }
  });

  // S-14 [unit] 英文侧必须渲染真实英文文案，而不是回落成 key 名。
  it("renders English labels for the capability group without falling back to key names", () => {
    const model = en.model as unknown as Record<string, string>;
    expect(model.capabilities).toBe("Capabilities");
    expect(model.imageInput).toBe("Text + image");
    expect(model.supportFunctionCalls).toBe("Tool calls");
  });

  it("中文能力项文案与设计一致", () => {
    const model = zh.model as unknown as Record<string, string>;
    expect(model.toolCalls, "工具调用能力项").toBe("工具调用");
    expect(model.imageInput, "图片能力项").toBe("文本+图片");
    expect(model.supportFunctionCalls, "函数调用 checkbox 文案").toBe("工具调用");
  });
});
