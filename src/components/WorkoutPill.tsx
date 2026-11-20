import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLogStore } from '@/store/logStore';
import { loadActiveRest, clearActiveRest, clock } from '@/lib/activeRest';
import { playRestComplete } from '@/utils/audio';
import './WorkoutPill.css';

// v1.22 (limelog#147) — the workout in progress, on every tab but the
// fullscreen workout: "● 12:40 · REST 0:47". Tapping it goes back to the
// workout. The rest record (lib/activeRest.ts) has an absolute end time, so
// the countdown is right whatever happened meanwhile; when it runs out while
// this is on screen, the same beep as the workout page plays, so the end of a
// rest is no longer silent off that screen. Loaded only while a workout is
// open (Layout), and its one interval runs only then.
export function WorkoutPill({ logId }: { logId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const startedAt = useLogStore((s) => s.sessionLogs.find((l) => l.id === logId)?.loggedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      const at = Date.now();
      const rest = loadActiveRest();
      if (rest && rest.logId === logId && at >= rest.endsAt) {
        clearActiveRest();
        playRestComplete();
      }
      setNow(at);
    }, 1000);
    return () => clearInterval(id);
  }, [logId]);

  if (!startedAt) return null;
  const rest = loadActiveRest();
  const restLeft = rest && rest.logId === logId && rest.endsAt > now ? (rest.endsAt - now) / 1000 : null;
  const elapsed = (now - new Date(startedAt).getTime()) / 1000;

  return (
    <button
      type="button"
      className={`workout-pill${restLeft !== null ? ' workout-pill--resting' : ''}`}
      onClick={() => navigate(`/workout/${logId}`)}
      aria-label={t('log.pillReturn')}
    >
      <span className="workout-pill__dot" aria-hidden="true" />
      <span className="workout-pill__time">{clock(elapsed)}</span>
      {restLeft !== null && (
        <span className="workout-pill__rest">{t('log.pillRest', { time: clock(Math.ceil(restLeft)) })}</span>
      )}
    </button>
  );
}
