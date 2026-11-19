// Shared Limecore i18n setup (Phase 0). Same pattern across NCC / LimeLog /
// StudyDesk — see D:\emilh\Projects\limecore\I18N_GUIDE.md.
//
// Detection order (per the v1.6 plan):
//   1. localStorage override  — set by a future in-app language switcher
//   2. device locale          — in a Capacitor WebView, navigator.language
//                               reflects the Android system locale, so no
//                               native @capacitor/device plugin is needed
//   3. 'en' fallback
//
// v1.17 (limecore#18): only English, the fallback, is bundled. Each other
// language is its own chunk: the active one loads before first render
// (main.tsx waits on `i18nReady`), the rest only when the user switches. The
// chunks are part of dist, so they ship inside the APK and load offline. Init
// itself is still synchronous, so no Suspense boundary is required
// (react.useSuspense = false).
//
// v1.22 (limecore#126): English is a chunk too. It is still the fallback, so
// `i18nReady` loads it alongside the active language, and first render waits
// for both exactly as it waited for the active one before. Its strings no
// longer count against the startup budget (scripts/check-bundle-size.mjs).
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

export const SUPPORTED_LANGS = ['en', 'fi', 'fr', 'de', 'es', 'zh', 'hi', 'pt', 'id', 'ar'] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

// Spelled out rather than globbed, so a missing locale file fails the build
// instead of a user's first launch.
const LOADERS: Record<Lang, () => Promise<{ default: object }>> = {
  en: () => import('./locales/en.json'),
  fi: () => import('./locales/fi.json'),
  fr: () => import('./locales/fr.json'),
  de: () => import('./locales/de.json'),
  es: () => import('./locales/es.json'),
  zh: () => import('./locales/zh.json'),
  hi: () => import('./locales/hi.json'),
  pt: () => import('./locales/pt.json'),
  id: () => import('./locales/id.json'),
  ar: () => import('./locales/ar.json'),
};

const LANG_STORAGE_KEY = 'limecore_lang';

/** Native (endonym) display names for the in-app language switcher. */
export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: 'English',
  fi: 'Suomi',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  zh: '中文',
  hi: 'हिन्दी',
  pt: 'Português',
  id: 'Bahasa Indonesia',
  ar: 'العربية',
};

function isSupported(code: string): code is Lang {
  return (SUPPORTED_LANGS as readonly string[]).includes(code);
}

function detectLanguage(): Lang {
  // 1. explicit override
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (stored && isSupported(stored)) return stored;
  } catch {
    /* localStorage may be unavailable (private mode / WebView quirk) */
  }
  // 2. device locale (WebView reports the system locale here)
  const nav = (
    (typeof navigator !== 'undefined' &&
      (navigator.languages?.[0] || navigator.language)) ||
    'en'
  ).toLowerCase();
  const base = nav.split('-')[0];
  if (isSupported(base)) return base;
  // 3. fallback
  return 'en';
}

/** Persist + apply a manual language choice (for the future Settings switcher). */
export async function setLanguage(lang: Lang): Promise<void> {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* ignore persistence failure — still switch in-memory */
  }
  await applyLanguage(lang);
}

async function loadLanguage(lang: Lang): Promise<void> {
  if (i18n.hasResourceBundle(lang, 'translation')) return;
  const { default: strings } = await LOADERS[lang]();
  i18n.addResourceBundle(lang, 'translation', strings);
}

// Loading is async, so two quick taps could finish out of order and leave the
// app in the first language while storage holds the second. The last request
// wins.
let requested: Lang | undefined;

async function applyLanguage(lang: Lang): Promise<void> {
  requested = lang;
  // English is the fallback for any key a language lacks, so it is loaded
  // whatever the active language is (a no-op after the first call). A failed
  // fallback must not keep the active language from applying.
  await Promise.all([loadLanguage('en').catch(() => {}), loadLanguage(lang)]);
  if (requested !== lang) return;
  applyDirection(lang);
  await i18n.changeLanguage(lang);
}


/** Languages that render right-to-left. Arabic is the only one so far. */
const RTL_LANGS: readonly Lang[] = ['ar'];

function isRtl(lang: string): boolean {
  return (RTL_LANGS as readonly string[]).includes(lang.split('-')[0]);
}

/**
 * Mirror the document for RTL languages.
 *
 * Set on <html> rather than a React root so it covers portals (modals, the
 * sign-out confirm) too, and so CSS logical properties resolve correctly for
 * the whole tree. `lang` goes on at the same time — it drives hyphenation and
 * font fallback, which matters for Devanagari and Arabic script.
 */
function applyDirection(lang: string): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  el.dir = isRtl(lang) ? 'rtl' : 'ltr';
  el.lang = lang.split('-')[0];
}

i18n.use(initReactI18next).init({
  resources: {},
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LANGS as unknown as string[],
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
  react: { useSuspense: false },
});

/**
 * Resolves once the detected language and the English fallback are loaded and
 * the detected one is active, with <html dir> and <html lang> set for it.
 * Never rejects: if a chunk cannot load, the app starts rather than not
 * starting (the chunks ship inside the APK, so on a device this does not
 * happen).
 */
export const i18nReady: Promise<void> = applyLanguage(detectLanguage()).catch(() => {});

export default i18n;
