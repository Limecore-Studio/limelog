import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor } from '@capacitor/core';
import { supabase } from '@/lib/supabase';
import { useNexusStore } from '@/store/nexusStore';
import { shouldAskReferral } from '@/lib/referralSource';
import { consentOwner, setConsent, unanswered, type ConsentItem } from '@/lib/consent';
import '@/i18n/consentStrings';
import './ReferralPrompt.css';
import './ConsentPrompt.css';

// v1.21.1 (limecore#87) — the one question for the two optional network
// features, asked once per account or guest (consent.ts has the rules):
//   - the F-Droid update check, on Android, from the first launch on;
//   - the app-open record, once signed in (a guest has nothing to record).
// Each item starts unselected; Done saves a yes only where the person chose
// one, so leaving an item alone is a no. Either way it is not asked again for
// this owner, and Profile → Settings has both switches.
//
// The same corner card as the referral prompt, and like it not a modal: the
// app is usable while it is up. It waits while the referral prompt is asking,
// so the two never stack; it asks on a later launch instead.
const DELAY_MS = 1500;

export function ConsentPrompt() {
  const { t } = useTranslation();
  const userId = useNexusStore((s) => s.userId);
  const [ask, setAsk] = useState<{ owner: string; items: ConsentItem[] } | null>(null);
  const [answers, setAnswers] = useState<Partial<Record<ConsentItem, boolean>>>({});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setAsk(null);
    void (async () => {
      const items: ConsentItem[] = [];
      if (Capacitor.getPlatform() === 'android') items.push('updateCheck');
      if (userId) {
        items.push('appOpens');
        const user = (await supabase.auth.getSession()).data.session?.user ?? null;
        if (shouldAskReferral(user)) return;
      }
      const owner = consentOwner();
      const open = unanswered(items, owner);
      if (cancelled || open.length === 0) return;
      timer = setTimeout(() => {
        setAnswers({});
        setAsk({ owner, items: open });
      }, DELAY_MS);
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [userId]);

  if (!ask) return null;

  const done = () => {
    const saved = Object.fromEntries(ask.items.map((i) => [i, answers[i] === true]));
    setConsent(saved, ask.owner);
    setAsk(null);
    // A yes to the update check takes effect now rather than next launch.
    if (saved.updateCheck) void import('@/lib/fdroidUpdate').then((m) => m.checkFdroidUpdate());
  };

  return (
    <div className="ref-card consent-card" role="dialog" aria-live="polite" aria-label={t('consent.title')}>
      <div className="ref-eyebrow">{t('consent.eyebrow')}</div>
      <div className="ref-title">{t('consent.title')}</div>
      {ask.items.map((item) => (
        <div key={item} className="consent-item">
          <div className="consent-item__label">{t(`consent.${item}`)}</div>
          <div className="consent-item__note">{t(`consent.${item}Note`)}</div>
          <div className="consent-item__choice" role="group" aria-label={t(`consent.${item}`)}>
            {([false, true] as const).map((on) => (
              <button
                key={String(on)}
                type="button"
                className={`consent-choice${answers[item] === on ? ' consent-choice--active' : ''}`}
                aria-pressed={answers[item] === on}
                onClick={() => setAnswers((a) => ({ ...a, [item]: on }))}
              >
                {on ? t('consent.yes') : t('consent.no')}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button type="button" className="ref-option consent-done" onClick={done}>
        {t('consent.done')}
      </button>
      <div className="consent-later">{t('consent.later')}</div>
    </div>
  );
}
