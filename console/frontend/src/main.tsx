import React from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider } from "@douyinfe/semi-ui";
import zh_CN from "@douyinfe/semi-ui/lib/es/locale/source/zh_CN";
import { App } from "./App";
import "./styles.css";

// 屏蔽 Semi v2.x 内部的 findDOMNode deprecation 警告。
// 触发源：Table 走 react-resizable@3、Modal 走 react-draggable@4、Popover/Dropdown
// 内部 tooltip/index.js:404。这些在 React 18 StrictMode 下持续打 console.error，
// 但不影响功能。等 Semi / 上游修了再撤。
// 注意：React 警告走 `console.error("Warning: %s\n\n%s", msg, stack)`，
// 实际消息在 args[1] 不是 args[0]（格式串），要把所有参数都看一遍。
const origError = console.error;
const origWarn = console.warn;
const filter = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
  if (args.some((a) => String(a ?? "").includes("findDOMNode"))) return;
  orig.apply(console, args);
};
console.error = filter(origError);
console.warn = filter(origWarn);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider locale={zh_CN}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
