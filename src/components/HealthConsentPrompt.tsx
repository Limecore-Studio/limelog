import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNexusStore } from '@/store/nexusStore';
import { useBodyMetricsStore } from '@/store/bodyMetricsStore';
import { useLogStore } from '@/store/logStore';
import { syncAllowed } from '@/lib/syncSetting';
import { healthConsent, healthOwner, HEALTH_ASK_EVENT, HEALTH_BODY_FIELDS } from '@/lib/healthConsent';
import { grantHealthConsent, refuseHealthConsent } from '@/lib/healthConsentActions';
import '@/i18n/healthStrings';
import './ReferralPrompt.css';
import './ConsentPrompt.css';

// v1.22 (limecore#91, GDPR Art. 9(2)(a)) — the one-time question before any
// health data is synced (healthConsent.ts has the rules). Asked:
//   - signed in with sync on, when this device holds health data not yet
//     answered for (an update that finds readings or debriefs, or the first
//     one recorded: bodyMetricsStore and the debrief ask through the event);
//   - from the debrief, for a guest too, before the note goes to AI.
// Until answered nothing health-related is pushed; either answer is final
// for this owner, and Settings changes it.
const DELAY_MS = 2500;

function holdsHealthData(): boolean {
  if (useBodyMetricsStore.getState().metrics.some((m) => HEALTH_BODY_FIELDS.some((f) => m[f] !== undefined))) return true;
  return useLogStore.getState().sessionLogs.some((l) => !!(l.aiDebriefRaw || l.aiPainFlags?.length || l.aiNoteSummary));
}

export function HealthConsentPrompt() {
  const { t } = useTranslation();
  const userId = useNexusStore((s) => s.userId);
  const [owner, setOwner] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (userId && syncAllowed() && healthConsent() === 'unasked' && holdsHealthData()) setOwner(healthOwner());
    }, DELAY_MS);
    const onAsk = () => {
      if (healthConsent() === 'unasked') setOwner(healthOwner());
    };
    window.addEventListener(HEALTH_ASK_EVENT, onAsk);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(HEALTH_ASK_EVENT, onAsk);
    };
  }, [userId]);

  if (!owner || owner !== healthOwner()) return null;

  const answer = (yes: boolean) => {
    if (yes) grantHealthConsent();
    else refuseHealthConsent();
    setOwner(null);
  };

  return (
    <div className="ref-card consent-card" role="dialog" aria-live="polite" aria-label={t('healthConsent.title')}>
      <div className="ref-eyebrow">{t('healthConsent.eyebrow')}</div>
      <div className="ref-title">{t('healthConsent.title')}</div>
      <div className="consent-item__note">{t('healthConsent.body')}</div>
      <div className="consent-item__choice" role="group" aria-label={t('healthConsent.title')}>
        <button type="button" className="consent-choice" onClick={() => answer(false)}>
          {t('healthConsent.decline')}
        </button>
        <button type="button" className="consent-choice consent-choice--active" onClick={() => answer(true)}>
          {t('healthConsent.agree')}
        </button>
      </div>
      <div className="consent-later">{t('healthConsent.later')}</div>
    </div>
  );
}
