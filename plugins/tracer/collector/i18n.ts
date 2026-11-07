/** Request language for generated text: English is the default, Chinese is opt-in. */
export type Lang = "en" | "zh";

/** Normalize a `lang` query value or an Accept-Language header; anything that is not zh falls back to en. */
export function langOf(value: string | null | undefined): Lang {
  return /^zh\b|^zh-/i.test(String(value ?? "").trim()) ? "zh" : "en";
}

/** Pick the message matching the request language. */
export function msg(lang: Lang, en: string, zh: string): string {
  return lang === "zh" ? zh : en;
}

/** Resolve the language from the `lang` query first, then Accept-Language; English wins by default. */
export function langOfHeaders(query: string | null, acceptLanguage: string | string[] | undefined): Lang {
  if (query) return langOf(query);
  return langOf(Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage);
}

/** Cache scope; analyses are stored per language so switching the toggle triggers a recompute. */
export function scopeOf(base: string, lang: Lang): string {
  return lang === "zh" ? base : `${base}:${lang}`;
}
