import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "./locales/zh";
import en from "./locales/en";

export type Language = "zh" | "en";

export const LANGUAGE_KEY = "muad_lang";

export function readLanguage(): Language {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    // ignore storage errors; fall through to navigator detection
  }
  return String(navigator.language ?? "")
    .toLowerCase()
    .startsWith("zh")
    ? "zh"
    : "en";
}

i18n.use(initReactI18next).init({
  resources: { zh: { translation: zh }, en: { translation: en } },
  lng: readLanguage(),
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
  // 资源为静态内联，同步初始化保证 import 后 t() 立即可用（测试确定性关键）。
  initAsync: false,
});

export default i18n;
