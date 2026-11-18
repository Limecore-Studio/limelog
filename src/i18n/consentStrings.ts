// v1.21.1 (limecore#87) — the `consent.*` strings, loaded with the consent
// prompt and the Profile page instead of at startup. Same mechanism and the
// same reasons as passwordStrings.ts (read its header): en.json is in the
// startup bundle, whose budget only goes down. Import this module for its side
// effect from any file that uses a `consent.*` key; keys.test.ts counts these
// keys as present.
import i18n from 'i18next';
import STRINGS from './consentStrings.json';

function register(lng: string) {
  const strings = (STRINGS as Record<string, Record<string, string>>)[lng];
  if (!strings || !i18n.hasResourceBundle(lng, 'translation')) return;
  i18n.addResourceBundle(lng, 'translation', { consent: strings }, true, true);
}

const registerAll = () => Object.keys(STRINGS).forEach(register);
if (i18n.isInitialized) registerAll();
else i18n.on('initialized', registerAll);
i18n.on('languageChanged', register);
