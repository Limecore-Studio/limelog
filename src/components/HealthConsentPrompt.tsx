import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNexusStore } from '@/store/nexusStore';
import { useBodyMetricsStore } from '@/store/bodyMetricsStore';
import { useLogStore } from '@/store/logStore';
import { syncAllowed } from '@/lib/syncSetting';
import { healthConsent, healthOwner, healthQuestionOpen, HEALTH_ASK_EVENT, HEALTH_BODY_FIELDS } from '@/lib/healthConsent';
import { grantHealthConsent, refuseHealthConsent, requeueHealthData } from '@/lib/healthConsentActions';
import { readHealthConsentFromCloud } from '@/lib/healthConsentCloud';
import { healthAllowed } from '@/lib/healthConsent';
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
  // v1.22 (S24 pass) — signed in, the answer that counts is the account's,
  // which needs the account to have taken the device's data up (the owner
  // record). Until then healthOwner() falls back to the guest, so a guest's
  // "Keep on this device" read as the account's answer while the "guest
  // data" question was still open, and the account was never asked. The
  // checks below wait for the owner, and run again when that question ends.
  const guestDataAsk = useNexusStore((s) => s.guestDataAsk);
  const [owner, setOwner] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Signed in, the account's answer comes first (limecore#135): a yes or a
    // withdrawal given on another device applies here, and is not asked again.
    const settle = async (): Promise<boolean> => {
      if (!healthQuestionOpen(userId)) return false;
      if (!userId) return true;
      const had = await readHealthConsentFromCloud();
      if (had && healthAllowed()) requeueHealthData();
      return !cancelled && healthConsent() === 'unasked';
    };
    const timer = setTimeout(() => {
      if (!userId || !syncAllowed() || !holdsHealthData()) return;
      void settle().then((ask) => ask && setOwner(healthOwner()));
    }, DELAY_MS);
    const onAsk = () => {
      void settle().then((ask) => ask && setOwner(healthOwner()));
    };
    window.addEventListener(HEALTH_ASK_EVENT, onAsk);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener(HEALTH_ASK_EVENT, onAsk);
    };
  }, [userId, guestDataAsk]);

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
