// v1.19 (LL#104) — height (with its log and BMI) and the smart-scale trends,
// as two cards on the Body page. The data and the maths are in
// lib/bodyScale.ts; this is only the presentation.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '@/components/ui';
import { useBodyMetricsStore } from '@/store/bodyMetricsStore';
import {
  HEIGHT_MAX_CM,
  HEIGHT_MIN_CM,
  SCALE_METRICS,
  formatHeight,
  formatScale,
  heightSeries,
  latestBmi,
  parseHeight,
  scaleSeries,
  type ScaleKey,
} from '@/lib/bodyScale';

function todayLocalIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function HeightCard() {
  const { t } = useTranslation();
  const metrics = useBodyMetricsStore((s) => s.metrics);
  const sys = useBodyMetricsStore((s) => s.prefs.unitSystem);
  const addOrUpdate = useBodyMetricsStore((s) => s.addOrUpdate);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [err, setErr] = useState(false);

  const series = useMemo(() => heightSeries(metrics), [metrics]);
  const latest = series[series.length - 1];
  const bmi = useMemo(() => latestBmi(metrics), [metrics]);
  const imperial = sys === 'imperial';

  // "Update height" adds a measurement for today; an earlier one stays in the log.
  function save() {
    const cm = parseHeight(sys, a, b);
    if (cm === null) { setErr(true); return; }
    if (cm === undefined) return;
    addOrUpdate({ date: todayLocalIso(), heightCm: cm });
    setA(''); setB(''); setErr(false);
  }

  return (
    <Card padding="md">
      <div className="body-metrics-section__header">
        <h3 className="body-metrics-section__title">{t('body.height.title')}</h3>
        {bmi && <span className="body-metrics-trend-pill is-flat" title={t('body.height.bmiNote')}>{t('body.height.bmi', { bmi: bmi.bmi.toFixed(1) })}</span>}
      </div>
      <p className="body-height__now">
        {latest
          ? t('body.height.current', { height: formatHeight(latest.value, sys), date: latest.date })
          : t('body.height.none')}
      </p>
      <div className="body-height__form">
        {imperial ? (
          <>
            <input type="number" inputMode="numeric" min="1" max="8" step="1" placeholder={t('body.height.ft')} aria-label={t('body.height.ft')} value={a} onChange={(e) => { setA(e.target.value); setErr(false); }} />
            <input type="number" inputMode="decimal" min="0" max="11.9" step="0.5" placeholder={t('body.height.in')} aria-label={t('body.height.in')} value={b} onChange={(e) => { setB(e.target.value); setErr(false); }} />
          </>
        ) : (
          <input type="number" inputMode="decimal" min={HEIGHT_MIN_CM} max={HEIGHT_MAX_CM} step="0.1" placeholder="cm" aria-label={t('body.height.title')} value={a} onChange={(e) => { setA(e.target.value); setErr(false); }} />
        )}
        <Button variant="secondary" size="sm" onClick={save} disabled={!a.trim() && !b.trim()}>{t('body.height.update')}</Button>
      </div>
      {err && <p className="body-metrics-error" role="alert">{t('body.height.outOfRange', { min: formatHeight(HEIGHT_MIN_CM, sys), max: formatHeight(HEIGHT_MAX_CM, sys) })}</p>}
      {series.length >= 2 && (
        <SeriesChart points={series} format={(v) => formatHeight(v, sys)} label={t('body.height.chart')} />
      )}
    </Card>
  );
}

export function ScaleTrendsCard() {
  const { t } = useTranslation();
  const metrics = useBodyMetricsStore((s) => s.metrics);
  const sys = useBodyMetricsStore((s) => s.prefs.unitSystem);
  const withData = useMemo(() => SCALE_METRICS.filter((m) => scaleSeries(metrics, m.key).length > 0), [metrics]);
  const [picked, setPicked] = useState<ScaleKey | null>(null);
  if (!withData.length) return null;
  const spec = withData.find((m) => m.key === picked) ?? withData[0];
  const points = scaleSeries(metrics, spec.key);
  const last = points[points.length - 1];
  return (
    <Card padding="md">
      <h3 className="body-metrics-section__title">{t('body.scale.trends')}</h3>
      <div className="body-metrics-prefs__chips" role="tablist" aria-label={t('body.scale.trends')}>
        {withData.map((m) => (
          <button
            key={m.key}
            type="button"
            role="tab"
            aria-selected={m.key === spec.key}
            className={`body-chip ${m.key === spec.key ? 'is-on' : ''}`}
            onClick={() => setPicked(m.key)}
          >{t(m.labelKey)}</button>
        ))}
      </div>
      <p className="body-height__now">{t('body.scale.latest', { value: formatScale(spec, last.value, sys), date: last.date })}</p>
      {points.length >= 2
        ? <SeriesChart points={points} format={(v) => formatScale(spec, v, sys)} label={t(spec.labelKey)} />
        : <p className="body-metrics-empty">{t('body.scale.needTwo')}</p>}
    </Card>
  );
}

// The same plain inline SVG as the weight chart, for any one series.
function SeriesChart({ points, format, label }: { points: { date: string; value: number }[]; format: (v: number) => string; label: string }) {
  const w = 320; const h = 120; const padL = 44; const padR = 8; const padT = 12; const padB = 20;
  const data = points.slice(-90);
  const ys = data.map((p) => p.value);
  const lo = Math.min(...ys); const hi = Math.max(...ys);
  const pad = (hi - lo) * 0.1 || Math.max(Math.abs(hi) * 0.02, 0.5);
  const minY = lo - pad; const maxY = hi + pad;
  const x = (i: number) => padL + (i / Math.max(1, data.length - 1)) * (w - padL - padR);
  const y = (v: number) => padT + (1 - (v - minY) / (maxY - minY)) * (h - padT - padB);
  const path = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" className="body-metrics-chart" role="img" aria-label={label}>
      <text x={padL - 4} y={padT + 4} className="body-metrics-chart__axis" textAnchor="end">{format(hi)}</text>
      <text x={padL - 4} y={h - padB} className="body-metrics-chart__axis" textAnchor="end">{format(lo)}</text>
      <path d={path} fill="none" className="body-metrics-chart__line" />
      {data.map((p, i) => <circle key={p.date} cx={x(i)} cy={y(p.value)} r={2.5} className="body-scale-chart__dot" />)}
    </svg>
  );
}
