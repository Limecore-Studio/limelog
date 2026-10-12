import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProgramStore } from '@/store/programStore';
import { useLogStore } from '@/store/logStore';
import { useUserStore } from '@/store/userStore';
import { useBodyMetricsStore } from '@/store/bodyMetricsStore';
import { formatDate, toDisplayWeight, formatDuration, formatDistance } from '@/utils/helpers';
import { EmptyState, Card, Button, Tabs, TabPanel } from '@/components/ui';
import { JumpLogModal } from '@/components/JumpLogModal';
import { LoadChart } from '@/components/LoadChart';
import { OneRMChart } from '@/components/OneRMChart';
import { PRHistory } from '@/components/PRHistory';
import { bestEstimateForExercise } from '@/utils/oneRepMax';
import { strengthToBodyweight } from '@/lib/bodyMetricsAnalysis';
import { BarChart2, TrendingUp, Zap } from 'lucide-react';
import './ProgressPage.css';

// v1.3 — the Body tab was promoted to its own /body page (BUG-19); ProgressPage
// keeps the training-analytics tabs only.
type ProgressTab = 'load' | 'orm' | 'jump' | 'history';

export function ProgressPage() {
  const { t } = useTranslation();
  const { programs, exercises } = useProgramStore();
  const { sessionLogs, jumpLogs, stallFlags, getSetsForExercise } = useLogStore();
  const { profile } = useUserStore();
  // v1.2 — latest bodyweight for the strength-to-bodyweight ratio shown on
  // the 1RM leaderboard. Selector reads the latest entry that has weight set.
  const latestBodyweightKg = useBodyMetricsStore((s) => s.latestWeight());
  const [selectedExId, setSelectedExId] = useState<string>(exercises[0]?.id ?? '');
  const [showJumpModal, setShowJumpModal] = useState(false);
  const [activeTab, setActiveTab] = useState<ProgressTab>('load');

  const unit = profile.unitPreference;
  const activeStalls = stallFlags.filter((f) => !f.resolved);

  const exercisedLogged = exercises.filter((e) => getSetsForExercise(e.id).length > 0);

  const recentJumps = [...jumpLogs]
    .sort((a, b) => new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime())
    .slice(0, 10);

  const finalizedLogs = [...sessionLogs]
    .filter((l) => l.finalizedAt !== undefined)
    .sort((a, b) => new Date(b.finalizedAt!).getTime() - new Date(a.finalizedAt!).getTime());

  function getSessionName(sessionTemplateId: string): string {
    for (const prog of programs) {
      const session = prog.sessions.find((s) => s.id === sessionTemplateId);
      if (session) return session.name;
    }
    return t('progress.unknownSession');
  }

  return (
    <div className="progress-page">
      <h1 className="progress-page__title">{t('progress.title')}</h1>

      <Tabs
        tabs={[
          { key: 'load', label: t('progress.tabLoad') },
          { key: 'orm', label: t('progress.tabOrm') },
          { key: 'jump', label: t('progress.tabJump') },
          { key: 'history', label: t('progress.tabHistory') },
        ]}
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as ProgressTab)}
      />

      <TabPanel tabKey="load" activeKey={activeTab}>
        <>
          {activeStalls.length > 0 && (
            <div className="progress-stalls">
              <span className="progress-stalls__label">{t('progress.stallFlags')}</span>
              {activeStalls.map((f) => {
                const ex = exercises.find((e) => e.id === f.exerciseId);
                return (
                  <div key={f.id} className="progress-stall-item">
                    {/* Was English-only in a box that is otherwise translated —
                        found while fixing this box's spacing. */}
                    <span>{ex?.name ?? t('progress.unknownExercise')}</span>
                    <span className="progress-stall-item__type">
                      {f.flagType === 'weight_plateau'
                        ? t('progress.stallWeightPlateau')
                        : t('progress.stallRpeCreep')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {exercisedLogged.length === 0 ? (
            <EmptyState icon={<BarChart2 size={36} />} title={t('progress.noLoadTitle')} description={t('progress.noLoadBody')} />
          ) : (
            <>
              <select
                aria-label={t('progress.selectExercise')}
                className="progress-exercise-select"
                value={selectedExId}
                onChange={(e) => setSelectedExId(e.target.value)}
              >
                {exercisedLogged.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
              {selectedExId && <LoadChart exerciseId={selectedExId} sessionLogs={sessionLogs} unit={unit} />}
            </>
          )}
        </>
      </TabPanel>

      <TabPanel tabKey="orm" activeKey={activeTab}>
        <>
          {/* Estimated 1RM = Brzycki for reps ≤ 10, Epley for 11-12, null
              above 12 reps (formula reliability craters). Per-exercise
              dropdown reuses the same logged-exercise list as the load
              tab so empty exercises don't clutter. Below the chart, a
              ranked list of every exercise's best e1RM gives an at-a-
              glance leaderboard across the user's main lifts. */}
          {exercisedLogged.length === 0 ? (
            <EmptyState
              icon={<TrendingUp size={36} />}
              title={t('progress.noOrmTitle')}
              description={t('progress.noOrmBody')}
            />
          ) : (
            <>
              <select
                aria-label={t('progress.selectExerciseOrm')}
                className="progress-exercise-select"
                value={selectedExId}
                onChange={(e) => setSelectedExId(e.target.value)}
              >
                {exercisedLogged.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
              {selectedExId && (
                <OneRMChart exerciseId={selectedExId} sessionLogs={sessionLogs} unit={unit} />
              )}

              {/* Best-ever leaderboard — sorted by estimated 1RM descending.
                  Useful for at-a-glance "where am I strongest" view without
                  cycling the dropdown across every lift. */}
              <div className="progress-orm-list">
                <div className="progress-orm-list__header">{t('progress.bestEstimates')}</div>
                {exercisedLogged
                  .map((e) => ({ ex: e, best: bestEstimateForExercise(sessionLogs, e.id) }))
                  .filter((row) => row.best != null)
                  .sort((a, b) => (b.best ?? 0) - (a.best ?? 0))
                  .slice(0, 10)
                  .map((row) => {
                    const display = toDisplayWeight(row.best ?? 0, unit);
                    // v1.2 — strength-to-bodyweight ratio (best 1RM / latest
                    // logged weight). Only rendered when the user has weight
                    // entries; staying quiet for weight-only-1RM users.
                    const ratio = strengthToBodyweight(row.best, latestBodyweightKg);
                    return (
                      <div key={row.ex.id} className="progress-orm-row">
                        <span className="progress-orm-row__name">{row.ex.name}</span>
                        <span className="progress-orm-row__value">
                          {display} {unit}
                          {ratio != null && (
                            <span
                              className="progress-orm-row__ratio"
                              title={t('progress.strengthRatio')}
                            >
                              {' '}· {ratio.toFixed(2)}× BW
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
              </div>

              {/* v1.7 — deferred-from-v1.6 PR history. Per-exercise estimated
                  1RM progression sparkline + tap-through to the full PR list.
                  Renders nothing until the first PR is detected. */}
              <PRHistory unit={unit} />
            </>
          )}
        </>
      </TabPanel>

      <TabPanel tabKey="jump" activeKey={activeTab}>
        <>
          <div className="progress-jump-header">
            <span className="progress-jump-header__count">{jumpLogs.length} entries</span>
            <Button size="sm" variant="primary" onClick={() => setShowJumpModal(true)}>
              <Zap size={13} aria-hidden="true" /> {t('progress.logJump')}
            </Button>
          </div>

          {recentJumps.length === 0 ? (
            <EmptyState icon={<Zap size={36} />} title={t('progress.noJumpsTitle')} description={t('progress.noJumpsBody')} action={<Button variant="primary" onClick={() => setShowJumpModal(true)}>{t('progress.logFirstJump')}</Button>} />
          ) : (
            recentJumps.map((j) => (
              <Card key={j.id} padding="sm">
                <div className="jump-entry">
                  <div>
                    <span className="jump-entry__height">{j.heightCm} cm</span>
                    <span className="jump-entry__condition">{j.condition.replace('_', ' ')}</span>
                  </div>
                  <span className="jump-entry__date">{formatDate(j.loggedAt)}</span>
                </div>
                {j.notes && <p className="jump-entry__notes">{j.notes}</p>}
              </Card>
            ))
          )}
        </>
      </TabPanel>

      {showJumpModal && <JumpLogModal onClose={() => setShowJumpModal(false)} />}

      <TabPanel tabKey="history" activeKey={activeTab}>
        <>
          {finalizedLogs.length === 0 ? (
            <EmptyState icon={<BarChart2 size={36} />} title={t('progress.noHistoryTitle')} description={t('progress.noHistoryBody')} />
          ) : (
            finalizedLogs.map((l) => {
              const totalSets = l.sets.filter((s) => s.completed).length;
              // v1.9 (Item 4) — a cardio entry has no session template and no
              // sets, so it names and measures itself differently. `sets`
              // would read "0 sets" for a 10 km run, which is worse than
              // saying nothing.
              const isCardio = !!l.activityType;
              return (
                <Card key={l.id} padding="sm">
                  <div className="history-entry">
                    <div className="history-entry__main">
                      <span className="history-entry__name">
                        {isCardio
                          ? t(`cardio.activity.${l.activityType}`, { defaultValue: l.activityType })
                          : getSessionName(l.sessionTemplateId ?? '')}
                      </span>
                      <span className="history-entry__date">{formatDate(l.finalizedAt!)}</span>
                    </div>
                    <div className="history-entry__meta">
                      {isCardio ? (
                        <>
                          {l.durationSeconds !== undefined && (
                            <span className="history-entry__sets">{formatDuration(l.durationSeconds)}</span>
                          )}
                          {l.distanceMeters !== undefined && (
                            <span className="history-entry__sets">{formatDistance(l.distanceMeters, unit)}</span>
                          )}
                        </>
                      ) : (
                        <span className="history-entry__sets">{totalSets} sets</span>
                      )}
                      {l.perceivedFatigue !== null && (
                        <span className="history-entry__fatigue">RPE {l.perceivedFatigue}</span>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })
          )}
        </>
      </TabPanel>
    </div>
  );
}
