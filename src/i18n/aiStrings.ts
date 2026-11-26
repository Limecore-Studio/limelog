// v1.22 (limecore#122) — the `ai.*` strings (the user's own Gemini key, and
// why an AI request failed), loaded with the Profile page and the debrief
// instead of at startup. Same mechanism and reasons as consentStrings.ts:
// en.json is in the startup bundle, whose budget only goes down. Import this
// module for its side effect from any file that uses an `ai.*` key;
// keys.test.ts counts these keys as present. Same wording as NCC's.
import i18n from 'i18next';
import STRINGS from './aiStrings.json';

function register(lng: string) {
  const strings = (STRINGS as Record<string, Record<string, unknown>>)[lng];
  if (!strings || !i18n.hasResourceBundle(lng, 'translation')) return;
  i18n.addResourceBundle(lng, 'translation', { ai: strings }, true, true);
}

const registerAll = () => Object.keys(STRINGS).forEach(register);
if (i18n.isInitialized) registerAll();
else i18n.on('initialized', registerAll);
i18n.on('languageChanged', register);
