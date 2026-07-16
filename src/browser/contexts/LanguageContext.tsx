import {
  createContext,
  useContext,
  useEffect,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { UI_LANGUAGE_KEY } from "@/common/constants/storage";
import { ZH_CN } from "@/browser/i18n/translations/zh-CN";
import { normalizeUiLanguage, type UiLanguage } from "@/common/i18n/uiLanguage";
import { translateExact } from "@/common/i18n/translateExact";

export type Language = UiLanguage;

export const LANGUAGE_OPTIONS: Array<{ value: Language; label: string }> = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
];

interface LanguageContextValue {
  language: Language;
  setLanguage: Dispatch<SetStateAction<Language>>;
  t: (text: string) => string;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: "en",
  setLanguage: () => undefined,
  t: (text) => text,
});

export function LanguageProvider(props: { children: ReactNode }) {
  const [rawLanguage, setRawLanguage] = usePersistedState<unknown>(UI_LANGUAGE_KEY, "en", {
    listener: true,
  });
  const language = normalizeUiLanguage(rawLanguage);
  const setLanguage: Dispatch<SetStateAction<Language>> = (value) => {
    setRawLanguage((current: unknown) => {
      const normalizedCurrent = normalizeUiLanguage(current);
      return typeof value === "function" ? value(normalizedCurrent) : value;
    });
  };

  useEffect(() => {
    document.documentElement.lang = language;
    window.api?.setUiLanguage?.(language);
  }, [language]);

  // English source text is the fallback so untranslated surfaces remain usable.
  const t = (text: string) => (language === "zh-CN" ? translateExact(ZH_CN, text) : text);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {props.children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}
