import { Button } from "@douyinfe/semi-ui";
import { IconMoon, IconSun } from "@douyinfe/semi-icons";
import { useTranslation } from "react-i18next";

export type ThemeMode = "dark" | "light";

export function ThemeButton({ mode, onClick }: { mode: ThemeMode; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      aria-label={mode === "dark" ? t("common.switchToLight") : t("common.switchToDark")}
      icon={mode === "dark" ? <IconMoon /> : <IconSun />}
      theme="borderless"
      size="small"
      onClick={onClick}
    />
  );
}
