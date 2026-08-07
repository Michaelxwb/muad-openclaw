import zh_CN from "@douyinfe/semi-ui/lib/es/locale/source/zh_CN";
import en_US from "@douyinfe/semi-ui/lib/es/locale/source/en_US";
import type { Locale } from "@douyinfe/semi-ui/lib/es/locale/interface";
import type { Language } from "./index";

// 页面语言 → Semi 组件语言包，让 Table/Modal/DatePicker 等内置文案跟随切换。
export function semiLocale(lang: Language): Locale {
  return lang === "en" ? en_US : zh_CN;
}
