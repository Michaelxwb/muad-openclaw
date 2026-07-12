import { Button } from "@douyinfe/semi-ui";
import { IconMoon, IconSun } from "@douyinfe/semi-icons";

export type ThemeMode = "dark" | "light";

export function ThemeButton({ mode, onClick }: { mode: ThemeMode; onClick: () => void }) {
  return (
    <Button
      aria-label={mode === "dark" ? "切换到浅色主题" : "切换到深色主题"}
      icon={mode === "dark" ? <IconMoon /> : <IconSun />}
      theme="borderless"
      size="small"
      onClick={onClick}
    />
  );
}
