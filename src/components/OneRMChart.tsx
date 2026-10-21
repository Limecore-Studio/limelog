import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionLog } from '@/types/logging';
import { oneRMHistoryForExercise } from '@/utils/oneRepMax';
import { toDisplayWeight } from '@/utils/helpers';
import './LoadChart.css';

interface Props {
  exerciseId: string;
  sessionLogs: SessionLog[];
  unit: 'kg' | 'lb';
}

/**
 * Estimated 1RM trend sparkline for one exercise.
 *
 * Visual layout mirrors LoadChart for consistency (same SVG dims, padding,
 * lime fill). Different x-axis labels (per-session best e1RM rather than
 * top-set weight) so the two charts are distinguishable when viewed back-
 * to-back. Uses up to the last 12 finalized sessions that contain at least
 * one valid (weight, reps) set for the exercise; fewer than 2 points
 * renders an empty state since a single dot isn't a trend.
 *
 * Estimation logic (Brzycki/Epley blend, MAX_RELIABLE_REPS cap) lives in
 * src/utils/oneRepMax.ts — this is purely a presentation layer over the
 * data the helper returns.
 */
export function OneRMChart({ exerciseId, sessionLogs, unit }: Props) {
  const { t } = useTranslation();
  const data = useMemo(() => {
    const points = oneRMHistoryForExercise([], sessionLogs, exerciseId).slice(-12);
    return points.map((p) => {
      const d = new Date(p.date);
      const weight = toDisplayWeight(p.estKg, unit);
      return {
        weight,
        label: `${d.getDate()}/${d.getMonth() + 1}`,
        setWeight: toDisplayWeight(p.setWeightKg, unit),
        setReps: p.setReps,
      };
    });
  }, [exerciseId, sessionLogs, unit]);

  if (data.length < 2) {
    return (
      <div className="load-chart load-chart--empty">
        <p>{t('chart.needMoreSessions')}</p>
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.weight));
  const min = Math.min(...data.map((d) => d.weight));
  const range = max - min || 1;

  const W = 320;
  const H = 120;
  const padTop = 12;
  const padRight = 16;
  const padBottom = 28;
  const padLeft = 36;
  const chartW = W - padLeft - padRight;
  const chartH = H - padTop - padBottom;

  const points = data.map((d, i) => ({
    x: padLeft + (i / (data.length - 1)) * chartW,
    y: padTop + chartH - ((d.weight - min) / range) * chartH,
    d,
  }));

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  const areaD = [
    pathD,
    `L ${points[points.length - 1].x.toFixed(1)} ${(padTop + chartH).toFixed(1)}`,
    `L ${padLeft} ${(padTop + chartH).toFixed(1)}`,
    'Z',
  ].join(' ');

  return (
    <div className="load-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="load-chart__svg" role="img" aria-label={t('progress.ormTrend')}>
        <defs>
          <linearGradient id="orm-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#c8f135" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#c8f135" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#orm-grad)" />
        <path d={pathD} fill="none" stroke="#c8f135" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="3" fill="#c8f135">
              <title>
                {p.d.weight.toFixed(1)} {unit} estimated (from {p.d.setWeight.toFixed(1)} {unit} × {p.d.setReps})
              </title>
            </circle>
            <text x={p.x} y={H - 6} textAnchor="middle" fontSize="9" fill="#545c66">
              {p.d.label}
            </text>
          </g>
        ))}
        <text x={padLeft - 4} y={padTop + 4} textAnchor="end" fontSize="9" fill="#545c66">
          {max.toFixed(1)}
        </text>
        <text x={padLeft - 4} y={padTop + chartH} textAnchor="end" fontSize="9" fill="#545c66">
          {min.toFixed(1)}
        </text>
      </svg>
      <p className="load-chart__unit">{t('progress.ormCaption', { unit })}</p>
    </div>
  );
}
