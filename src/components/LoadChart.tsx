import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import './LoadChart.css';
import type { SessionLog } from '@/types/logging';
import { toDisplayWeight } from '@/utils/helpers';

interface Props {
  exerciseId: string;
  sessionLogs: SessionLog[];
  unit: 'kg' | 'lb';
}

interface DataPoint {
  topWeight: number;
  label: string;
}

export function LoadChart({ exerciseId, sessionLogs, unit }: Props) {
  const { t } = useTranslation();
  const data: DataPoint[] = useMemo(() => {
    return sessionLogs
      .filter((l) => l.sets.some((s) => s.exerciseId === exerciseId && s.weightKg !== null))
      .sort((a, b) => new Date(a.loggedAt).getTime() - new Date(b.loggedAt).getTime())
      .slice(-12)
      .map((l) => {
        const weights = l.sets
          .filter((s) => s.exerciseId === exerciseId && s.weightKg !== null)
          .map((s) => toDisplayWeight(s.weightKg!, unit));
        const top = Math.max(...weights);
        const d = new Date(l.loggedAt);
        return { topWeight: top, label: `${d.getDate()}/${d.getMonth() + 1}` };
      });
  }, [exerciseId, sessionLogs, unit]);

  if (data.length < 2) {
    return (
      <div className="load-chart load-chart--empty">
        <p>{t('progress.needTwo')}</p>
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.topWeight));
  const min = Math.min(...data.map((d) => d.topWeight));
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
    y: padTop + chartH - ((d.topWeight - min) / range) * chartH,
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
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="load-chart__svg"
        role="img"
        aria-label={t('progress.loadTrend')}
      >
        <defs>
          <linearGradient id="lc-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#c8f135" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#c8f135" stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={areaD} fill="url(#lc-grad)" />
        <path
          d={pathD}
          fill="none"
          stroke="#c8f135"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="3" fill="#c8f135" />
            <text
              x={p.x}
              y={H - 6}
              textAnchor="middle"
              fontSize="9"
              fill="#545c66"
            >
              {p.d.label}
            </text>
          </g>
        ))}

        <text
          x={padLeft - 4}
          y={padTop + 4}
          textAnchor="end"
          fontSize="9"
          fill="#545c66"
        >
          {max.toFixed(1)}
        </text>
        <text
          x={padLeft - 4}
          y={padTop + chartH}
          textAnchor="end"
          fontSize="9"
          fill="#545c66"
        >
          {min.toFixed(1)}
        </text>
      </svg>
      <p className="load-chart__unit">{t('progress.loadCaption', { unit })}</p>
    </div>
  );
}
