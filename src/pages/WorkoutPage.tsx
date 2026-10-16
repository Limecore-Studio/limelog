import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProgramStore } from '@/store/programStore';
import { useLogStore } from '@/store/logStore';
import { useUserStore } from '@/store/userStore';
import { formatWeight, toDisplayWeight, fromDisplayWeight } from '@/utils/helpers';
import { playRestComplete } from '@/utils/audio';
import { getLastSessionSets, type LastSessionRef } from '@/lib/lastSessionSets';
import { resolveDone } from '@/lib/setCompletion';
import type { SetLog, ExercisePR } from '@/types/logging';
import { WeightUpModal, type QualifyingExercise } from '@/components/WeightUpModal';
import { FatigueRating } from '@/components/FatigueRating';
import { DebriefSection } from '@/components/DebriefSection';
import { useConfirm } from '@/components/confirmContext';
import { PlateBar } from '@/components/PlateBar';
import { PlateKeypad } from '@/components/PlateKeypad';
import { WeightInput } from '@/components/WeightInput';
import { convertLoad, usesBarbell } from '@/utils/plateMath';
import { useThemeStore } from '@/store/themeStore';
import { SwapExerciseSheet } from '@/components/SwapExerciseSheet';
import { effectiveExerciseId } from '@/lib/exerciseSwap';
import { ChevronLeft, Plus, Trash2, X, Flag, Play, Timer, ArrowLeftRight, Disc } from 'lucide-react';
import './WorkoutPage.css';

const DEFAULT_REST_SECONDS = 90;

function parseRepCeiling(targetReps: string): number {
  const cleaned = targetReps.replace('–', '-').replace('–', '-');
  const parts = cleaned.split('-');
  return parseInt(parts[parts.length - 1], 10);
}

// v1.7 (BUG-9) — the rest timer is now WALL-CLOCK based, not a decrementing
// in-memory counter. The old model ran `setInterval` subtracting 1 each tick
// and held the count only in React state — so backgrounding the app (Android
// freezes WebView JS timers) made it drift/appear to "reset," and a process
// kill wiped it entirely, dumping the user out of the workout with no timer.
// Now we persist the ABSOLUTE end time to localStorage and always derive the
// remaining seconds from `Date.now()`. Backgrounding no longer matters (on
// resume we just recompute from wall-clock), and a kill-then-resume rehydrates
// the live timer from storage. The persisted record is scoped to the workout's
// logId so a stale timer never bleeds into a different session.
interface RestState {
  /** Absolute epoch ms when the rest ends. */
  endsAt: number;
  total: number;
  exerciseName: string;
}

interface PersistedRest extends RestState {
  logId: string;
}

const ACTIVE_REST_KEY = 'wt_active_rest';

function loadActiveRest(): PersistedRest | null {
  try {
    const raw = localStorage.getItem(ACTIVE_REST_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PersistedRest;
    return typeof p?.endsAt === 'number' && typeof p?.logId === 'string' ? p : null;
  } catch {
    return null;
  }
}

function saveActiveRest(r: RestState, logId: string): void {
  try {
    localStorage.setItem(ACTIVE_REST_KEY, JSON.stringify({ ...r, logId }));
  } catch {
    /* non-fatal — the in-memory timer still works this session */
  }
}

function clearActiveRest(): void {
  try {
    localStorage.removeItem(ACTIVE_REST_KEY);
  } catch {
    /* ignore */
  }
}

function remainingSecs(rest: RestState | null, now: number): number {
  return rest ? Math.max(0, Math.ceil((rest.endsAt - now) / 1000)) : 0;
}

export function WorkoutPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { logId = '' } = useParams();
  const navigate = useNavigate();
  const { programs, exercises, updateSessionExercise } = useProgramStore();
  const { sessionLogs, logSet, updateSet, deleteSet, swapExercise, setPerceivedFatigue, finalizeSession, discardSession, currentPRFor } = useLogStore();
  const { profile } = useUserStore();
  // v1.14 Item 13 — the bay is a Cast Iron idea, so the weight-up modal
  // asks the same question ExerciseSection already asks further down.
  const pageTheme = useThemeStore((s) => s.theme);

  const log = sessionLogs.find((l) => l.id === logId) ?? null;
  // v1.18.1 (LimeLog#74 review): looked up in every program, not just the
  // active one, so a workout Today offers to resume always opens: one started
  // under another program, or in a phase deleted since (deletePhase keeps it).
  const session = useMemo(
    () => programs.flatMap((p) => p.sessions).find((s) => s.id === log?.sessionTemplateId) ?? null,
    [programs, log?.sessionTemplateId]
  );

  const [rest, setRest] = useState<RestState | null>(null);
  // Bumped once a second while a rest is active, purely to re-render the
  // wall-clock-derived countdown. Not the source of truth — `rest.endsAt` is.
  const [, setTick] = useState(0);
  const [modal, setModal] = useState<{ qualifying: QualifyingExercise[] } | null>(null);
  // v1.15 Item 8 — the SessionExercise whose swap sheet is open.
  const [swapSeId, setSwapSeId] = useState<string | null>(null);

  // Rehydrate a still-running rest on mount (covers process-death + resume, and
  // a plain remount). Only adopt it if it belongs to THIS workout and hasn't
  // already elapsed; otherwise clear the stale record.
  useEffect(() => {
    const saved = loadActiveRest();
    if (saved && saved.logId === logId && saved.endsAt > Date.now()) {
      setRest({ endsAt: saved.endsAt, total: saved.total, exerciseName: saved.exerciseName });
    } else if (saved) {
      clearActiveRest();
    }
  }, [logId]);

  // The single interval: while a rest is active, tick once a second to refresh
  // the countdown, and fire completion the moment wall-clock passes endsAt.
  // Re-created whenever `rest` changes (start / adjust / skip), so there's never
  // a dangling timer. Because remaining is derived from Date.now(), a resume
  // after backgrounding is automatically correct — no drift, no reset.
  useEffect(() => {
    if (!rest) return;
    const check = () => {
      if (Date.now() >= rest.endsAt) {
        playRestComplete();
        clearActiveRest();
        setRest(null);
      } else {
        setTick((t) => t + 1);
      }
    };
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, [rest]);

  const startRest = useCallback((secs: number, exerciseName: string) => {
    if (!secs || secs <= 0) return;
    const next: RestState = { endsAt: Date.now() + secs * 1000, total: secs, exerciseName };
    saveActiveRest(next, logId);
    setRest(next);
  }, [logId]);

  const skipRest = useCallback(() => {
    clearActiveRest();
    setRest(null);
  }, []);

  const adjustRest = useCallback((delta: number) => {
    setRest((prev) => {
      if (!prev) return null;
      const nextRemaining = Math.max(1, remainingSecs(prev, Date.now()) + delta);
      const next: RestState = {
        ...prev,
        endsAt: Date.now() + nextRemaining * 1000,
        total: Math.max(prev.total, nextRemaining),
      };
      saveActiveRest(next, logId);
      return next;
    });
  }, [logId]);

  if (!log || !session) {
    return (
      <div className="workout-page workout-page--missing">
        <button className="workout-page__back" onClick={() => navigate('/today')}>
          <ChevronLeft size={18} /> {t('common.back')}
        </button>
        <p className="workout-page__missing-msg">{t('log.missing')}</p>
      </div>
    );
  }

  const orderedExercises = [...session.exercises].sort((a, b) => a.orderIndex - b.orderIndex);
  const completedCount = log.sets.filter((s) => s.completed).length;
  const plannedCount = orderedExercises.reduce((sum, se) => sum + se.targetSets, 0);
  const pct = plannedCount > 0 ? Math.min(100, (completedCount / plannedCount) * 100) : 0;

  // The "current" exercise is the first one that still has incomplete sets — drives the idle rest bar.
  const currentExercise = orderedExercises.find((se) => {
    const exId = effectiveExerciseId(log, se);
    const exDoneSets = log.sets.filter((s) => s.exerciseId === exId && s.completed).length;
    return exDoneSets < se.targetSets;
  }) ?? orderedExercises[0];
  const currentExerciseObj = currentExercise
    ? exercises.find((e) => e.id === effectiveExerciseId(log, currentExercise))
    : undefined;
  const idleRestSecs = currentExercise?.restSeconds ?? DEFAULT_REST_SECONDS;
  const idleRestLabel = currentExerciseObj?.name ?? 'workout';

  function computeQualifying(): QualifyingExercise[] {
    if (!log || !session) return [];
    const result: QualifyingExercise[] = [];
    for (const se of session.exercises) {
      // v1.15 Item 8 — a swapped slot never proposes a weight increase: the
      // target weight belongs to the programmed lift, and topping out on a
      // lighter substitute says nothing about it.
      if (log.exerciseSwaps?.[se.id]) continue;
      const exercise = exercises.find((e) => e.id === se.exerciseId);
      if (!exercise) continue;
      const completedSets = log.sets.filter((s) => s.exerciseId === se.exerciseId && s.completed);
      if (completedSets.length === 0) continue;
      const ceiling = parseRepCeiling(se.targetReps);
      if (isNaN(ceiling)) continue;
      const allHitCeiling = completedSets.every((s) => s.reps !== null && s.reps >= ceiling);
      if (!allHitCeiling) continue;
      if (se.targetRpe !== undefined) {
        const allBelowRpe = completedSets.every((s) => s.rpe === null || s.rpe <= se.targetRpe! - 1);
        if (!allBelowRpe) continue;
      }
      const pattern = exercise.movementPattern;
      const increment = pattern === 'squat' || pattern === 'hinge' ? 5 : 2.5;
      result.push({ se, exercise, increment, sessionId: session.id });
    }
    return result;
  }

  function handleFinish() {
    const qualifying = computeQualifying();
    if (qualifying.length > 0) {
      setModal({ qualifying });
    } else {
      finalizeSession(log!.id);
      clearActiveRest();
      navigate('/today');
    }
  }

  function handleModalConfirm(confirmedSeIds: string[]) {
    if (!modal) return;
    for (const item of modal.qualifying) {
      if (confirmedSeIds.includes(item.se.id)) {
        const newWeight = (item.se.targetWeight ?? 0) + item.increment;
        updateSessionExercise(item.sessionId, item.se.id, { targetWeight: newWeight });
      }
    }
    finalizeSession(log!.id);
    clearActiveRest();
    setModal(null);
    navigate('/today');
  }

  function handleModalSkip() {
    finalizeSession(log!.id);
    clearActiveRest();
    setModal(null);
    navigate('/today');
  }

  async function handleDiscard() {
    // Was a hardcoded English string in a native confirm() — see TodayPage.
    if (!(await confirm({ message: t('log.discardConfirm') }))) return;
    discardSession(log!.id);
    clearActiveRest();
    navigate('/today');
  }

  function getRestrictionForExercise(exId: string) {
    const exercise = exercises.find((e) => e.id === exId);
    if (!exercise) return null;
    return profile.activeRestrictions.find(
      (r) =>
        r.active &&
        (r.restrictedExerciseIds.includes(exId) ||
          r.restrictedPatterns.includes(exercise.movementPattern))
    ) ?? null;
  }

  const restRemaining = remainingSecs(rest, Date.now());
  const restPct = rest ? (restRemaining / rest.total) * 100 : 0;
  const restUrgent = rest !== null && restRemaining <= 5;

  return (
    <div className="workout-page" style={{ '--workout-progress': `${pct}%` } as React.CSSProperties}>
      {/* Sticky top: rest bar OR session header */}
      <div className="workout-top">
        <div className="workout-top__bar">
          <button className="workout-top__back" onClick={() => navigate('/today')} aria-label={t('common.back')}>
            <ChevronLeft size={20} />
          </button>
          <div className="workout-top__title">
            <span className="workout-top__session">{session.name}</span>
            <span className="workout-top__progress-text">
              {t('log.setsProgress', { done: completedCount, total: plannedCount })}
            </span>
          </div>
          <button className="workout-top__discard" onClick={handleDiscard} aria-label={t('log.discardWorkout')}>
            <Trash2 size={16} />
          </button>
        </div>

        {/* Session progress bar */}
        <div className="workout-top__progress" aria-hidden="true">
          <div className="workout-top__progress-fill" style={{ width: `${pct}%` }} />
        </div>

        {/* Persistent rest bar — idle state acts as a one-tap timer launcher */}
        <div className={`rest-bar${rest ? ' rest-bar--active' : ' rest-bar--idle'}${restUrgent ? ' rest-bar--urgent' : ''}`}>
          <div
            className="rest-bar__fill"
            style={{ width: rest ? `${restPct}%` : '0%' }}
            aria-hidden="true"
          />
          <div className="rest-bar__content">
            {rest ? (
              <>
                <div className="rest-bar__label">
                  <span className="rest-bar__label-eyebrow">{t('log.restingEyebrow')}</span>
                  <span className="rest-bar__label-ex">{rest.exerciseName}</span>
                </div>
                <div className="rest-bar__seconds">
                  <span className="rest-bar__seconds-num">{restRemaining}</span>
                  <span className="rest-bar__seconds-unit">s</span>
                </div>
                <div className="rest-bar__actions">
                  <button onClick={() => adjustRest(-15)} aria-label={t('log.subSeconds')}>−15</button>
                  <button onClick={() => adjustRest(15)} aria-label={t('log.addSeconds')}>+15</button>
                  <button className="rest-bar__skip" onClick={skipRest} aria-label={t('log.skipRest')}>
                    <X size={16} />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="rest-bar__label">
                  <span className="rest-bar__label-eyebrow"><Timer size={11} /> {t('log.restTimer')}</span>
                  <span className="rest-bar__label-ex">{idleRestLabel} · {idleRestSecs}s</span>
                </div>
                <button
                  className="rest-bar__start"
                  onClick={() => startRest(idleRestSecs, idleRestLabel)}
                  aria-label={t('log.startRestAria', { secs: idleRestSecs })}
                >
                  <Play size={14} />
                  <span>{t('log.startRest')}</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="workout-body">
        {orderedExercises.map((se, idx) => {
          const exId = effectiveExerciseId(log, se);
          const exercise = exercises.find((e) => e.id === exId);
          if (!exercise) return null;
          const programmed = exId !== se.exerciseId ? exercises.find((e) => e.id === se.exerciseId) : undefined;
          const restriction = getRestrictionForExercise(exId);
          const isRestrictedAvoid = restriction?.severity === 'avoid';
          const mySets = log.sets
            .filter((s) => s.exerciseId === exercise.id)
            .sort((a, b) => a.setNumber - b.setNumber);
          const doneSets = mySets.filter((s) => s.completed).length;
          const allDone = doneSets >= se.targetSets;
          const lastSession = getLastSessionSets(sessionLogs, exercise.id, log.id);
          const pr = currentPRFor(exercise.id);

          return (
            <ExerciseSection
              key={se.id}
              index={idx + 1}
              exerciseName={exercise.name}
              exerciseId={exercise.id}
              equipment={exercise.equipment}
              lastSession={lastSession}
              pr={pr}
              targetSetsCount={se.targetSets}
              targetReps={se.targetReps}
              targetRpe={se.targetRpe}
              // The programmed weight is for the programmed lift, and would be
              // a wrong placeholder and plate bay for its substitute.
              targetWeight={programmed ? undefined : se.targetWeight}
              restSeconds={se.restSeconds}
              swappedFrom={programmed?.name}
              // Offered until the first set is done, then withdrawn: a finished
              // set is a lift that happened and a swap must not orphan it.
              onSwap={doneSets === 0 ? () => setSwapSeId(se.id) : undefined}
              restriction={restriction}
              isRestrictedAvoid={isRestrictedAvoid}
              sets={mySets}
              doneSets={doneSets}
              allDone={allDone}
              unit={profile.unitPreference}
              onLogSet={(newSet) =>
                logSet(log.id, { ...newSet, exerciseId: exercise.id, setNumber: mySets.length + 1 })
              }
              onUpdateSet={(setId, updates) => updateSet(log.id, setId, updates)}
              onDeleteSet={(setId) => deleteSet(log.id, setId)}
              onCompleteSet={(setId, completed, restSecs) => {
                updateSet(log.id, setId, { completed });
                // v1.18.1 (LimeLog#75): no stall check here any more. It ran on
                // every tick against the workout still in progress, so the first
                // set of a session flagged a plateau the rest of it then broke.
                // finalizeSession runs it once, on completed sets.
                if (completed) startRest(restSecs ?? DEFAULT_REST_SECONDS, exercise.name);
              }}
            />
          );
        })}

        <div className="workout-finalize">
          <FatigueRating
            value={log.perceivedFatigue}
            onChange={(v) => setPerceivedFatigue(log.id, v)}
          />

          {/* Opt-in only. FatigueRating above stays as the always-available
              way to record how the session went. */}
          {profile.aiEnabled && <DebriefSection logId={log.id} />}

          <button className="workout-finish-btn" onClick={handleFinish}>
            <Flag size={16} />
            <span>{t('log.finishWorkout')}</span>
          </button>
        </div>
      </div>

      {(() => {
        const se = swapSeId ? orderedExercises.find((x) => x.id === swapSeId) : undefined;
        const current = se ? exercises.find((e) => e.id === effectiveExerciseId(log, se)) : undefined;
        if (!se || !current) return null;
        const programmed = current.id !== se.exerciseId ? exercises.find((e) => e.id === se.exerciseId) ?? null : null;
        return (
          <SwapExerciseSheet
            current={current}
            programmed={programmed}
            exercises={exercises}
            restrictions={profile.activeRestrictions}
            onClose={() => setSwapSeId(null)}
            onPick={(toId) => {
              swapExercise(log.id, se.id, se.exerciseId, toId);
              setSwapSeId(null);
            }}
          />
        );
      })()}

      {modal && (
        <WeightUpModal
          qualifying={modal.qualifying}
          unit={profile.unitPreference}
          showBay={pageTheme === 'cast-iron'}
          onConfirm={handleModalConfirm}
          onSkip={handleModalSkip}
        />
      )}
    </div>
  );
}

interface ExerciseSectionProps {
  index: number;
  exerciseName: string;
  exerciseId: string;
  equipment?: string;
  lastSession?: LastSessionRef | null;
  pr?: ExercisePR | null;
  targetSetsCount: number;
  targetReps: string;
  targetRpe?: number;
  targetWeight?: number;
  restSeconds?: number;
  /** v1.15 Item 8 — name of the programmed exercise this one replaces. */
  swappedFrom?: string;
  /** Absent once a set is done, which hides the swap control. */
  onSwap?: () => void;
  restriction: { severity: string; label: string } | null;
  isRestrictedAvoid: boolean;
  sets: SetLog[];
  doneSets: number;
  allDone: boolean;
  unit: 'kg' | 'lb';
  onLogSet: (set: Omit<SetLog, 'id' | 'sessionLogId' | 'exerciseId' | 'setNumber'>) => void;
  onUpdateSet: (setId: string, updates: Partial<SetLog>) => void;
  onDeleteSet: (setId: string) => void;
  onCompleteSet: (setId: string, completed: boolean, restSecs: number | undefined) => void;
}

function ExerciseSection({
  index,
  exerciseName,
  equipment,
  lastSession,
  pr,
  targetSetsCount,
  targetReps,
  targetRpe,
  targetWeight,
  restSeconds,
  swappedFrom,
  onSwap,
  restriction,
  isRestrictedAvoid,
  sets,
  doneSets,
  allDone,
  unit,
  onLogSet,
  onUpdateSet,
  onDeleteSet,
  onCompleteSet,
}: ExerciseSectionProps) {
  const { t } = useTranslation();
  const [override, setOverride] = useState(false);
  const restricted = isRestrictedAvoid && !override;

  // ── The plate bay ────────────────────────────────────────────────────
  //
  // Cast Iron ONLY, and that is not a licensing decision — it is the theme's
  // regression gate. With `[data-theme]` unset the app has to render exactly
  // as it did before this theme existed, and a bar drawn across every
  // exercise header is not "exactly as it did".
  //
  // The weight shown is the one you are about to lift: the first set still
  // open, falling back to the programmed target. A bay showing the last
  // completed set would be a picture of work already done.
  // Two conditions the first cut of this missed, both from the v1.13 review.
  //
  // `usesBarbell` existed in plateMath and was never called, so the bay drew
  // an Olympic bar for cable and dumbbell work — a picture of equipment that
  // is not in the room.
  //
  // `convertLoad` existed and was never called either: the weight went
  // through `toDisplayWeight`, which rounds to one decimal for display. 100 kg
  // became 220.5 lb, no combination of plates makes a half pound, and every
  // ordinary set grew a spurious "+0.25 UNMADE" tape chip. `convertLoad`
  // snaps to the nearest load the plates can actually build, which is the
  // whole point of drawing them.
  const castIron = useThemeStore((s) => s.theme) === 'cast-iron';
  const nextSet = sets.find((s) => !s.completed);
  const nextWeightKg = nextSet?.weightKg ?? targetWeight ?? null;
  const showBay =
    castIron && !restricted && usesBarbell(equipment) && nextWeightKg != null && nextWeightKg > 0;
  // v1.14 Item 13 — the bay becomes the way in. It already shows the weight of
  // the set you are about to lift, so tapping it edits THAT set: one thing on
  // screen, one thing it changes. Nothing to open when there is no open set.
  const [keypadOpen, setKeypadOpen] = useState(false);
  const canStack = showBay && !!nextSet;
  // limelog#41 (owner, option C): the keypad is an input method, so it is
  // free in every theme. It gets its own button, "Load the bar", beside Add
  // set, for any barbell exercise with an open set, including one with no
  // weight yet (the bay needs a weight to draw). The drawing itself stays Cast
  // Iron: in other themes the keypad shows the total as a number instead.
  const canLoad = !restricted && usesBarbell(equipment) && !!nextSet;

  // limelog#42 (B2): DONE on an empty field logs the target shown in it; with
  // no target to take, DONE is refused and the reps field is flagged instead.
  const [repsNeeded, setRepsNeeded] = useState<string | null>(null);
  function tapDone(s: SetLog) {
    if (s.completed) {
      onCompleteSet(s.id, false, restSeconds);
      return;
    }
    const r = resolveDone(s, targetReps, targetWeight);
    if (!r.ok) {
      setRepsNeeded(s.id);
      document.getElementById(`reps-${s.id}`)?.focus();
      return;
    }
    if (Object.keys(r.fill).length > 0) onUpdateSet(s.id, r.fill);
    setRepsNeeded(null);
    onCompleteSet(s.id, true, restSeconds);
  }

  function addSet() {
    const last = sets[sets.length - 1];
    onLogSet({
      weightKg: last?.weightKg ?? targetWeight ?? null,
      reps: last?.reps ?? null,
      rpe: last?.rpe ?? null,
      completed: false,
    });
  }

  return (
    <section className={`ex-section${allDone ? ' ex-section--done' : ''}`}>
      <header className="ex-section__head">
        <div className="ex-section__index">{String(index).padStart(2, '0')}</div>
        <div className="ex-section__head-text">
          <h2 className="ex-section__name">{exerciseName}</h2>
          <div className="ex-section__meta">
            <span><strong>{targetSetsCount}</strong>×{targetReps}</span>
            {targetRpe !== undefined && <span>{t('log.colRpe')} {targetRpe}</span>}
            {targetWeight !== undefined && <span>{formatWeight(targetWeight, unit)}</span>}
            {restSeconds !== undefined && <span>{t('log.restSeconds', { secs: restSeconds })}</span>}
            {pr && (
              <span className="ex-section__pr" title={t('log.currentPr')}>
                PR {formatWeight(pr.weightKg, unit)}×{pr.reps}
              </span>
            )}
          </div>
        </div>
        <div className="ex-section__counter">
          <span className="ex-section__counter-done">{doneSets}</span>
          <span className="ex-section__counter-sep">/</span>
          <span className="ex-section__counter-target">{targetSetsCount}</span>
        </div>
      </header>

      {(swappedFrom || onSwap) && (
        <div className="ex-section__swap-row">
          {swappedFrom && <span className="ex-section__swapped">{t('log.swappedFrom', { name: swappedFrom })}</span>}
          {onSwap && (
            <button type="button" className="ex-section__swap" onClick={onSwap} aria-label={t('log.swapAria', { name: exerciseName })}>
              <ArrowLeftRight size={12} aria-hidden="true" />
              <span>{t('log.swap')}</span>
            </button>
          )}
        </div>
      )}

      {restriction && (
        <div className={`ex-section__flag${restriction.severity === 'avoid' ? ' ex-section__flag--avoid' : ' ex-section__flag--warn'}`}>
          <span>{t(restriction.severity === 'avoid' ? 'log.restrictionAvoid' : 'log.restrictionModify', { label: restriction.label })}</span>
          {restriction.severity === 'avoid' && !override && (
            <button onClick={() => setOverride(true)}>{t('log.override')}</button>
          )}
        </div>
      )}

      {showBay && (
        <PlateBar
          total={convertLoad(nextWeightKg as number, 'kg', unit)}
          unit={unit}
          size="md"
          interactive={canStack}
          onPress={canStack ? () => setKeypadOpen(true) : undefined}
        />
      )}

      {keypadOpen && nextSet && (
        <PlateKeypad
          initial={nextWeightKg != null && nextWeightKg > 0 ? convertLoad(nextWeightKg, 'kg', unit) : null}
          unit={unit}
          drawBar={castIron}
          onClose={() => setKeypadOpen(false)}
          // The keypad works in the DISPLAYED unit and the set stores kg, so
          // the answer is converted back on the way in. v1.18.1 (LimeLog#71):
          // exactly, the same way the weight field converts. It used to snap
          // to KILO plates (`convertLoad(total, unit, 'kg')`), so 225 lb of
          // pound plates was stored as 102.5 kg and read back as 226 lb. The
          // total is already a load the user's own plates build.
          onDone={(total) => {
            onUpdateSet(nextSet.id, { weightKg: fromDisplayWeight(total, unit) });
            setKeypadOpen(false);
          }}
        />
      )}

      {!restricted && (
        <div className="ex-section__sets">
          {/* v1.6 — progressive overload reference: what you did last time. */}
          {lastSession ? (
            <div className="ex-section__last">
              <span className="ex-section__last-label">{t('log.lastSession', { date: lastSession.date.slice(5) })}</span>
              <div className="ex-section__last-sets">
                {lastSession.sets.map((s) => (
                  <span key={s.id} className="ex-section__last-set">
                    {s.weightKg != null ? formatWeight(s.weightKg, unit) : '—'}
                    <span className="ex-section__last-x">×</span>
                    {s.reps ?? '—'}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="ex-section__last ex-section__last--empty">{t('log.noHistoryYet')}</div>
          )}

          <div className="ex-section__set-grid ex-section__set-grid--head">
            <span>{t('log.colDone')}</span>
            <span>{unit}</span>
            <span>{t('log.colReps2')}</span>
            <span>{t('log.colRpe')}</span>
            <span />
          </div>

          {sets.map((s) => (
            <div
              key={s.id}
              className={`ex-section__set-grid ex-section__set-row${s.completed ? ' ex-section__set-row--done' : ''}`}
            >
              <button
                className="ex-section__set-check"
                onClick={() => tapDone(s)}
                aria-label={s.completed ? t('log.setDone', { n: s.setNumber }) : t('log.markSetDone', { n: s.setNumber })}
              >
                {s.completed ? '✓' : s.setNumber}
              </button>
              <WeightInput
                weightKg={s.weightKg}
                unit={unit}
                placeholder={targetWeight !== undefined ? String(toDisplayWeight(targetWeight, unit)) : '—'}
                onChange={(weightKg) => onUpdateSet(s.id, { weightKg })}
              />
              <input
                type="number" inputMode="numeric" min="0" step="1"
                id={`reps-${s.id}`}
                aria-invalid={repsNeeded === s.id || undefined}
                value={s.reps ?? ''} placeholder={targetReps}
                onChange={(e) => {
                  if (repsNeeded === s.id) setRepsNeeded(null);
                  onUpdateSet(s.id, { reps: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) });
                }}
              />
              <input
                type="number" inputMode="decimal" min="6" max="10" step="0.5"
                value={s.rpe ?? ''} placeholder={targetRpe !== undefined ? String(targetRpe) : '—'}
                onChange={(e) => onUpdateSet(s.id, { rpe: e.target.value === '' ? null : Number(e.target.value) })}
              />
              <button
                className="ex-section__set-del"
                onClick={() => onDeleteSet(s.id)}
                aria-label={t('log.deleteSetN', { n: s.setNumber })}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}

          <div className="ex-section__actions">
            <button className="ex-section__add" onClick={addSet}>
              <Plus size={14} />
              <span>{t('log.addSet')}</span>
            </button>
            {canLoad && (
              <button type="button" className="ex-section__add" onClick={() => setKeypadOpen(true)}>
                <Disc size={14} aria-hidden="true" />
                <span>{t('log.plateKeypad')}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
