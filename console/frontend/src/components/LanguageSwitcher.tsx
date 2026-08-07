import { Button } from "@douyinfe/semi-ui";
import { IconLanguage } from "@douyinfe/semi-icons";
import { useLanguage } from "../i18n/LanguageProvider";
import type { Language } from "../i18n";

// 顶栏/登录页的语言切换按钮：中英互切，偏好写 localStorage。
export function LanguageSwitcher() {
  const { lang, setLang } = useLanguage();
  const next: Language = lang === "zh" ? "en" : "zh";
  return (
    <Button
      theme="borderless"
      icon={<IconLanguage />}
      aria-label={lang === "zh" ? "Switch to English" : "切换到中文"}
      onClick={() => setLang(next)}
    >
      {next === "zh" ? "中文" : "EN"}
    </Button>
  );
}
