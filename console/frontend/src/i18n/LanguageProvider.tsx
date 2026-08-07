import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import i18n, { readLanguage, LANGUAGE_KEY } from "./index";
import type { Language } from "./index";

interface LanguageContextValue {
  lang: Language;
  setLang: (next: Language) => void;
}

const LanguageContext = createContext<LanguageContextValue>({
  lang: "zh",
  setLang: () => {},
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    // i18n instance was already initialized with readLanguage(); keep state in sync.
    return (i18n.language as Language) || readLanguage();
  });
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = (next: Language) => {
    setLangState(next);
    void i18n.changeLanguage(next);
    try {
      localStorage.setItem(LANGUAGE_KEY, next);
    } catch (caught) {
      console.warn("language_preference_write_failed", caught);
    }
  };
  return <LanguageContext.Provider value={{ lang, setLang }}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}
