// 测试断言中文 DOM 文案；在 i18n 模块首次被组件 import 前锁定 zh。
// setupFiles 先于测试文件加载执行，因此 localStorage 在此写入后，
// src/i18n/index.ts 的 readLanguage() 会读到 zh。
try {
  localStorage.setItem("muad_lang", "zh");
} catch {
  // storage 不可用时忽略，readLanguage 仍会按 navigator.language 兜底
}

// 主动加载 i18n 实例：部分组件（如 RowActions）仅 import type 引 api，
// 不会传递触发 src/i18n 加载。这里确保全局 i18next 实例在任意测试前
// 已完成资源配置（initImmediate:false 同步初始化），t() 不再原样返回 key。
// 必须用动态 import：ESM 静态 import 会被提升到 localStorage 写入之前，
// 导致 readLanguage() 读不到 muad_lang 而回落到 navigator.language（英文）。
await import("../src/i18n");

HTMLCanvasElement.prototype.getContext = (() => ({
  fillRect: () => undefined,
  fillStyle: "",
})) as unknown as typeof HTMLCanvasElement.prototype.getContext;

export {};
