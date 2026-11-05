import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabase';
import { shouldAskReferral } from '@/lib/referralSource';
import { answerReportPrompt, noteSignedInLaunch, shouldAskForReports } from '@/lib/reportPrompt';
import './ReportPromptCard.css';

// v1.20 (limecore#71) — the one-time card that offers error reports. Layout
// mounts it for a signed-in account only (so never over the fullscreen
// workout) and loads it on demand. It counts the launch, decides for itself
// (lib/reportPrompt.ts), waits while the referral question is still due so
// the two never share a screen, and appears a few seconds in.
const SHOW_AFTER_MS = 4000;

export function ReportPromptCard() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    noteSignedInLaunch();
    void (async () => {
      if (!shouldAskForReports()) return;
      const { data } = await supabase.auth.getSession();
      if (cancelled || shouldAskReferral(data.session?.user ?? null)) return;
      timer = setTimeout(() => setOpen(true), SHOW_AFTER_MS);
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!open) return null;
  const answer = (yes: boolean) => {
    answerReportPrompt(yes);
    setOpen(false);
  };
  return (
    <div className="rp-card" role="dialog" aria-labelledby="rp-title">
      <div id="rp-title" className="rp-title">{t('reportPrompt.title')}</div>
      <p className="rp-body">{t('reportPrompt.body')}</p>
      <div className="rp-actions">
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => answer(false)}>{t('reportPrompt.notNow')}</button>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => answer(true)}>{t('reportPrompt.yes')}</button>
      </div>
    </div>
  );
}
