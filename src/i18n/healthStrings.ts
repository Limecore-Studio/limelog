// v1.22 (limecore#91) — the `healthConsent.*` strings (the health-data consent),
// loaded with the prompt, Settings and the debrief instead of at startup.
// Same mechanism and reasons as consentStrings.ts; keys.test.ts counts these
// keys as present.
import i18n from 'i18next';
import STRINGS from './healthStrings.json';

function register(lng: string) {
  const strings = (STRINGS as Record<string, Record<string, string>>)[lng];
  if (!strings || !i18n.hasResourceBundle(lng, 'translation')) return;
  i18n.addResourceBundle(lng, 'translation', { healthConsent: strings }, true, true);
}

const registerAll = () => Object.keys(STRINGS).forEach(register);
if (i18n.isInitialized) registerAll();
else i18n.on('initialized', registerAll);
i18n.on('languageChanged', register);
