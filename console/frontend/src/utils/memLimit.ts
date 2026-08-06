// 内存上限输入/展示统一按 GiB 数字处理（后端落库为 "Ng"，纯数字按 GiB 解释）。
// 把后端存的 "3g" / "2.5g" / "512m" 等转成 GiB 数字字符串，供输入框只显示数字。
export function memLimitToGB(value: string): string {
  const trimmed = value.trim();
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([gmbk])?$/i.exec(trimmed);
  if (!match) return trimmed;
  const num = Number(match[1]);
  const unit = (match[2] ?? "g").toLowerCase();
  let gb = num;
  if (unit === "m") gb = num / 1024;
  else if (unit === "k") gb = num / 1024 / 1024;
  else if (unit === "b") gb = num / 1024 / 1024 / 1024;
  return String(Math.round(gb * 1000) / 1000);
}
