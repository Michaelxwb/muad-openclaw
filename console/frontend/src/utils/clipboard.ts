// 复制文本到剪贴板，兼容内网 HTTP（非安全上下文）场景。
//
// navigator.clipboard 只在安全上下文（HTTPS 或 localhost）可用；内网用
// http://<ip>:<port> 访问 console 时 window.isSecureContext === false，
// navigator.clipboard 为 undefined，直接 writeText 会抛「复制失败」。
// 这里优先走 Clipboard API，不可用时降级到 document.execCommand("copy")
// （老 API，HTTP 下仍可用）。两者都失败时抛出异常，由调用方兜底提示。
export async function copyText(text: string): Promise<void> {
  if (typeof text !== "string" || text === "") {
    throw new Error("copy text is empty");
  }
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ok = fallbackCopy(text);
  if (!ok) {
    throw new Error("copy failed");
  }
}

function fallbackCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // 固定定位 + 透明 + 移出视口，避免 execCommand 时页面跳动/闪烁。
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.setAttribute("readonly", "");
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return ok;
}
