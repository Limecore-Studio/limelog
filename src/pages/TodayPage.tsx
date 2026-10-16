import { lazy, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProgramStore } from '@/store/programStore';
import { useLogStore } from '@/store/logStore';
import { useUserStore } from '@/store/userStore';
import type { SessionTemplate } from '@/types/program';
import { getDayOfWeek, formatWeight } from '@/utils/helpers';
import { sessionsForDay } from '@/lib/todaySessions';
import { bestEstimateForExercise, missedRepRatio } from '@/utils/oneRepMax';
import { EmptyState, Button, Badge } from '@/components/ui';
import { Dumbbell, AlertTriangle, CheckCircle2, TrendingUp, ChevronRight, Footprints } from 'lucide-react';
import { useConfirm } from '@/components/confirmContext';
import './TodayPage.css';
import { OptionalChunk } from '@/components/OptionalChunk';

// v1.18.1 (LimeLog#70) — out of the startup chunk. The cardio form opens only
// on a tap. The Health Connect strip renders nothing until its async
// capability and permission checks finish, so loading it after first paint
// changes nothing on screen; its code is shared with the Body page's card.
// Each sits in its own Suspense with no fallback: suspending to Layout's
// boundary would blank the whole page while the chunk loads.
const CardioLogModal = lazy(() => import('@/components/CardioLogModal').then((m) => ({ default: m.CardioLogModal })));
const HealthTodayStrip = lazy(() => import('@/components/HealthConnect').then((m) => ({ default: m.HealthTodayStrip })));

function isSameLocalDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function TodayPage() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const navigate = useNavigate();
  // v1.9 (Item 4) — cardio logging. Reachable from both branches of this page:
  // someone who only runs has no program, so gating it behind the program view
  // would hide it from exactly the person it exists for.
  const [showCardio, setShowCardio] = useState(false);
  const { activeProgram, exercises, advancePhase } = useProgramStore();
  const { sessionLogs, startSession, unfinalizeSession, discardSession, stallFlags } = useLogStore();
  const unit = useUserStore((s) => s.profile.unitPreference);

  const now = new Date();
  const today = getDayOfWeek();
  const dayName = t(`today.dayFull.${(['sun','mon','tue','wed','thu','fri','sat'] as const)[today]}`);
  const dateStr = now.toLocaleDateString(i18n.language || 'en', { day: 'numeric', month: 'long' });

  // v1.2 — phase tracking honors Program.activePhaseId when set. Old
  // programs without the field fall back to lowest-orderIndex (matches
  // v1.1 behavior). Sorted explicitly so the "next phase" lookup is
  // stable regardless of how phases are stored.
  function getCurrentPhaseAndNext() {
    if (!activeProgram || activeProgram.phases.length === 0) {
      return { current: null, next: null };
    }
    const sorted = [...activeProgram.phases].sort((a, b) => a.orderIndex - b.orderIndex);
    const idx = activeProgram.activePhaseId
      ? sorted.findIndex((ph) => ph.id === activeProgram.activePhaseId)
      : 0;
    const safeIdx = idx < 0 ? 0 : idx;
    return {
      current: sorted[safeIdx] ?? null,
      next: safeIdx < sorted.length - 1 ? sorted[safeIdx + 1] : null,
    };
  }
  const { current: phase, next: nextPhase } = getCurrentPhaseAndNext();

  // limelog#43 - the active phase's sessions for today, not every phase's.
  const todaySessions: SessionTemplate[] = sessionsForDay(activeProgram, today, phase?.id);

  // v1.2 — deload suggestion. Walks the last 3 finalized sessions and
  // compares logged reps to each exercise's targetReps lower-bound.
  // ≥30% missed-rep ratio surfaces a soft "consider deload" banner.
  // Does not auto-advance — the user always decides.
  const deloadSuggestion = useMemo(() => {
    if (!activeProgram) return null;
    if (phase?.type === 'deload') return null; // already on a deload phase
    const targetReps = new Map<string, string>();
    for (const session of activeProgram.sessions) {
      for (const se of session.exercises) {
        // Only first occurrence wins — different sessions can prescribe
        // different rep ranges for the same exercise; we use whichever
        // appears first as a reasonable default.
        if (!targetReps.has(se.exerciseId)) targetReps.set(se.exerciseId, se.targetReps);
      }
    }
    const recent = [...sessionLogs]
      .filter((l) => l.finalizedAt)
      .sort((a, b) => new Date(b.finalizedAt!).getTime() - new Date(a.finalizedAt!).getTime());
    const result = missedRepRatio(recent, targetReps, 3);
    // Need a meaningful sample size — single-set ratios overreact.
    if (result.totalSets < 10) return null;
    if (result.ratio < 0.3) return null;
    return result;
  }, [activeProgram, sessionLogs, phase?.type]);

  function handleAdvancePhase() {
    if (!activeProgram || !nextPhase) return;
    const advanced = advancePhase(activeProgram.id);
    if (advanced) {
      // No flash component here — the Badge update at the top of the
      // page provides instant visual confirmation that the advance
      // landed (phase name + variant change).
    }
  }

  function handleStartSession(session: SessionTemplate) {
    const log = startSession(session.id, activeProgram!.id);
    navigate(`/workout/${log.id}`);
  }

  function handleResume(logId: string) {
    navigate(`/workout/${logId}`);
  }

  async function handleDiscard(logId: string) {
    // Was a hardcoded English string in a native confirm() — the message stayed
    // English in all ten languages, and the buttons came from the OS locale.
    if (!(await confirm({ message: t('log.discardConfirm') }))) return;
    discardSession(logId);
  }

  const activeStalls = stallFlags.filter((f) => !f.resolved);

  if (!activeProgram) {
    return (
      <div className="today-page">
        <div className="today-header">
          <div>
            <span className="today-header__day">{dayName}</span>
            <span className="today-header__date">{dateStr}</span>
          </div>
        </div>
        <EmptyState
          icon={<Dumbbell size={36} />}
          title={t('today.noProgramTitle')}
          description={t('today.noProgramBody')}
          action={<Button variant="primary" onClick={() => navigate('/program')}>{t('today.goToPrograms')}</Button>}
        />
        {/* A program is for lifting. Cardio needs none, so it stays reachable
            here — this is the screen a runner who never builds a program sees
            every time they open the app. */}
        <Button variant="ghost" fullWidth onClick={() => setShowCardio(true)}>
          <Footprints size={16} /> {t('cardio.logButton')}
        </Button>
        {showCardio && (
          <OptionalChunk onFail={() => setShowCardio(false)}>
            <CardioLogModal onClose={() => setShowCardio(false)} />
          </OptionalChunk>
        )}
      </div>
    );
  }

  return (
    <div className="today-page">
      <div className="today-header">
        <div>
          <span className="today-header__day">{dayName}</span>
          <span className="today-header__date">{dateStr}</span>
        </div>
        {phase && (
          <Badge
            label={phase.name}
            variant={
              phase.type === 'deload' ? 'info'
              : phase.type === 'peaking' ? 'accent'
              : phase.type === 'intensification' ? 'warning'
              : 'muted'
            }
            size="md"
          />
        )}
      </div>

      {/* v1.3 BUG-20 — Health Connect daily activity strip. Renders nothing
          when Health Connect is unavailable (web / F-Droid / no HC app). */}
      <OptionalChunk>
        <HealthTodayStrip />
      </OptionalChunk>

      {/* v1.9 (Item 4) — a run or ride belongs to no program, so it sits
          outside the session list rather than inside it. */}
      <div className="today-cardio-row">
        <Button variant="ghost" size="sm" onClick={() => setShowCardio(true)}>
          <Footprints size={15} /> {t('cardio.logButton')}
        </Button>
      </div>
      {showCardio && (
        <OptionalChunk onFail={() => setShowCardio(false)}>
          <CardioLogModal onClose={() => setShowCardio(false)} />
        </OptionalChunk>
      )}

      {activeStalls.length > 0 && (
        <div className="today-alert">
          <AlertTriangle size={15} />
          {/* Was English-only, and pluralised with `length > 1 ? 's' : ''` —
              which is wrong even in English for 0, and meaningless in the nine
              other languages. i18next resolves the CLDR category instead. */}
          <span>{t('today.stallAlert', { count: activeStalls.length })}</span>
        </div>
      )}

      {/* v1.2 — deload suggestion from missed-rep heuristic. Only shows
          when ≥30% of completed sets in the last 3 sessions fell short
          of their target rep lower-bound, AND we're not already on a
          deload phase. Suggestion only — never auto-advances. */}
      {deloadSuggestion && (
        <div className="today-alert today-alert--warn">
          <AlertTriangle size={15} />
          {/* Two whole sentences rather than a shared stem plus a fragment:
              composing copy from pieces forces every translator into English
              word order. */}
          <span>
            {t(nextPhase ? 'today.deloadAdvance' : 'today.deloadSchedule', {
              missed: deloadSuggestion.missedSets,
              total: deloadSuggestion.totalSets,
            })}
          </span>
        </div>
      )}

      {/* v1.2 — phase advance prompt. Shown whenever there's a next
          phase available; the user manually triggers progression. The
          deload heuristic above can prompt this.
          v1.4 — variant + size aligned with Start session (primary md)
          since both are "begin the next thing" actions and should share
          the same visual weight. The chevron stays as a direction cue. */}
      {nextPhase && (
        <div className="today-phase-advance">
          <div className="today-phase-advance__copy">
            <span className="today-phase-advance__label">{t('today.nextPhase')}</span>
            <span className="today-phase-advance__name">{nextPhase.name}</span>
          </div>
          <Button variant="primary" size="md" onClick={handleAdvancePhase}>
            {t('today.advance')} <ChevronRight size={14} aria-hidden="true" />
          </Button>
        </div>
      )}

      {todaySessions.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 size={36} />}
          title={t('today.restTitle')}
          description={t('today.restBody')}
        />
      ) : (
        todaySessions.map((session) => {
          // Only today's logs count as "active for today" — last week's data stays in the past.
          const log = sessionLogs.find((l) =>
            l.sessionTemplateId === session.id && isSameLocalDay(l.loggedAt, now)
          );
          const isDone = log !== undefined && log.finalizedAt !== undefined;
          const isActive = log !== undefined && !isDone;

          const completedCount = log?.sets.filter((s) => s.completed).length ?? 0;
          const plannedCount = session.exercises.reduce((sum, se) => sum + se.targetSets, 0);

          // v1.2 — top estimated 1RM for the session's first exercise
          // (usually the main lift). Surfaces in the card header as
          // motivation/context. Omitted if no prior data exists.
          const firstEx = session.exercises[0];
          const firstExName = firstEx ? exercises.find((e) => e.id === firstEx.exerciseId)?.name : null;
          const firstExBest = firstEx ? bestEstimateForExercise(sessionLogs, firstEx.exerciseId) : null;

          return (
            <div key={session.id} className="today-session">
              <div className="today-session__header">
                <div className="today-session__title-block">
                  <span className="today-session__name">{session.name}</span>
                  <span className="today-session__sub">
                    {t('today.exercises', { count: session.exercises.length, sets: plannedCount })}
                  </span>
                  {firstExBest != null && firstExName && (
                    <span className="today-session__orm" title={t('today.e1rmTitle')}>
                      <TrendingUp size={11} aria-hidden="true" />
                      {' '}{t('today.topE1rm')} · {firstExName}: {formatWeight(firstExBest, unit)}
                    </span>
                  )}
                </div>
                {!log && (
                  <Button variant="primary" size="md" onClick={() => handleStartSession(session)}>
                    {t('today.start')}
                  </Button>
                )}
                {isActive && (
                  <div className="today-session__active-actions">
                    <Button variant="primary" size="md" onClick={() => handleResume(log!.id)}>
                      {t('today.resume')}
                    </Button>
                    <button
                      className="today-session__discard"
                      onClick={() => handleDiscard(log!.id)}
                      aria-label={t('today.discard')}
                    >
                      {t('today.discard')}
                    </button>
                  </div>
                )}
                {isDone && (
                  <div className="today-session__done-row">
                    <Badge label={t('today.done')} variant="success" />
                    <button
                      className="today-session__undo"
                      onClick={() => unfinalizeSession(log!.id)}
                    >
                      {t('today.undo')}
                    </button>
                  </div>
                )}
              </div>

              {isActive && (
                <div className="today-session__progress-row">
                  <div className="today-session__progress">
                    <div
                      className="today-session__progress-fill"
                      style={{ width: `${plannedCount > 0 ? Math.min(100, (completedCount / plannedCount) * 100) : 0}%` }}
                    />
                  </div>
                  <span className="today-session__progress-text">
                    {completedCount} / {plannedCount}
                  </span>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
