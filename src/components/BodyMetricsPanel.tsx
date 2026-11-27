// ── v1.2 BodyMetricsPanel ─────────────────────────────────────────────────
//
// All-in-one panel rendered inside ProgressPage's "Body" tab. Three regions:
//   1. Log card — weight (always shown) + opt-in measurements + notes.
//      "Today" button pre-fills today's date; date input lets the user
//      back-fill or correct an older entry.
//   2. Trend chart — last-90-days weight series with a 7-day MA overlay,
//      plus a delta pill ("−1.2 kg over 30d").
//   3. Photos — date-keyed local-only progress photos with capture button.
//
// Settings inline — the "Track…" chip row lets the user toggle which
// measurement fields appear in the form, so a weight-only user isn't
// confronted with six empty inputs.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PHOTO_DATE_KEY } from '@/lib/restoredResult';
import { useTranslation } from 'react-i18next';
import { Capacitor } from '@capacitor/core';
import {
  Camera as CapacitorCamera,
  CameraResultType,
  CameraSource,
} from '@capacitor/camera';
import { Button, Card } from '@/components/ui';
import { Camera, Download, Trash2 } from 'lucide-react';
import { useConfirm } from '@/components/confirmContext';
import { useBodyMetricsStore } from '@/store/bodyMetricsStore';
import type { BodyMetric } from '@/types/bodyMetrics';
import {
  formatLength,
  formatWeight,
  kgToLb,
  lbToKg,
  cmToIn,
  inToCm,
} from '@/types/bodyMetrics';
import {
  weightSeries,
  weightTrendOverDays,
} from '@/lib/bodyMetricsAnalysis';
import {
  savePhoto,
  savePhotoFromDataUrl,
  photoDataUrlFromWebPath,
  photoToEvict,
  savePhotoCopy,
  getPhoto,
  deletePhoto,
  listPhotos,
  PhotoError,
  type ProgressPhoto,
} from '@/lib/progressPhotos';
import { SCALE_METRICS, parseScaleInput, scaleToInput, scaleUnit, type ScaleKey } from '@/lib/bodyScale';
import { HeightCard, ScaleTrendsCard } from '@/components/BodyScaleCards';
import './BodyMetricsPanel.css';

function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const TRACK_OPTIONS = [
  { key: 'trackChest' as const, labelKey: 'body.chest' },
  { key: 'trackWaist' as const, labelKey: 'body.waist' },
  { key: 'trackHips' as const, labelKey: 'body.hips' },
  { key: 'trackArms' as const, labelKey: 'body.arms' },
  { key: 'trackLegs' as const, labelKey: 'body.legs' },
  // v1.19 (LL#104) — one chip for the whole smart-scale group.
  { key: 'trackScale' as const, labelKey: 'body.scale.chip' },
];

interface FormState {
  date: string;
  weight: string;
  chest: string;
  waist: string;
  hips: string;
  arms: string;
  legs: string;
  /** v1.19 (LL#104) — smart-scale readings, as typed. */
  scale: Record<ScaleKey, string>;
  notes: string;
}

const EMPTY_SCALE = Object.fromEntries(SCALE_METRICS.map((m) => [m.key, ''])) as Record<ScaleKey, string>;

const EMPTY_FORM: FormState = {
  date: todayLocalIso(),
  weight: '',
  chest: '',
  waist: '',
  hips: '',
  arms: '',
  legs: '',
  scale: EMPTY_SCALE,
  notes: '',
};

export function BodyMetricsPanel({ showTrend = true }: { showTrend?: boolean } = {}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const metrics = useBodyMetricsStore((s) => s.metrics);
  const prefs = useBodyMetricsStore((s) => s.prefs);
  const addOrUpdate = useBodyMetricsStore((s) => s.addOrUpdate);
  const remove = useBodyMetricsStore((s) => s.remove);
  const updatePrefs = useBodyMetricsStore((s) => s.updatePrefs);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // v1.22 (limelog#127) — the entry loaded for editing, as stored and as its
  // fields showed it: a field left as shown keeps the stored value, so an
  // imperial edit does not round the weight through lb on every save.
  const [loaded, setLoaded] = useState<{ row: BodyMetric; form: FormState } | null>(null);
  // v1.22 (limelog#127) — a weight or girth outside the server's range.
  const [fieldErr, setFieldErr] = useState<{ name: string; max: number } | null>(null);
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  // v1.19 (LL#104) — which scale field is out of range, if any.
  const [scaleErr, setScaleErr] = useState<ScaleKey | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [photosNonce, setPhotosNonce] = useState(0); // re-renders gallery
  // v1.22 (limecore#127) — the "Add body measurement" launcher shortcut
  // (open/body?add=1) lands on the entry form, weight field focused.
  const weightRef = useRef<HTMLInputElement | null>(null);
  const [params, setParams] = useSearchParams();
  const wantsAdd = params.get('add') === '1';
  useEffect(() => {
    if (!wantsAdd) return;
    setParams({}, { replace: true });
    const el = weightRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus();
  }, [wantsAdd, setParams]);
  // v1.22 (limelog#125) — a photo saved from a restored camera result
  // (App.tsx) while this panel is open shows up at once.
  useEffect(() => {
    const bump = () => setPhotosNonce((n) => n + 1);
    window.addEventListener('limelog:photos-changed', bump);
    return () => window.removeEventListener('limelog:photos-changed', bump);
  }, []);

  const unit = prefs.unitSystem;
  const isImperial = unit === 'imperial';

  // ── Derived ────────────────────────────────────────────────────────────
  const sorted = useMemo(
    () => [...metrics].sort((a, b) => (a.date < b.date ? 1 : -1)),
    [metrics],
  );
  const series = useMemo(() => weightSeries(metrics), [metrics]);
  const trend30 = useMemo(() => weightTrendOverDays(series, 30), [series]);

  // Photo list driven by nonce so save/delete refreshes synchronously. The
  // nonce is the intentional trigger — listPhotos() reads localStorage, which
  // has no reactive dep, so we bump photosNonce to force a re-read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const photos = useMemo(() => listPhotos(), [photosNonce]);
  const photoForFormDate = getPhoto(form.date);

  // ── Form parsing ───────────────────────────────────────────────────────
  function parseWeightInputToKg(input: string): number | undefined {
    if (!input) return undefined;
    const n = parseFloat(input);
    if (!isFinite(n) || n <= 0) return undefined;
    return isImperial ? lbToKg(n) : n;
  }
  function parseLengthInputToCm(input: string): number | undefined {
    if (!input) return undefined;
    const n = parseFloat(input);
    if (!isFinite(n) || n <= 0) return undefined;
    return isImperial ? inToCm(n) : n;
  }

  // v1.22 (limelog#127) — the server's limits (body_metrics CHECKs): a value
  // past them saved here and then failed every push, holding up the queue.
  const LIMITS = { weightKg: 500, chestCm: 300, waistCm: 300, hipsCm: 300, armsCm: 200, legsCm: 200 } as const;
  type Basic = keyof typeof LIMITS;
  const FIELD: Record<Basic, 'weight' | 'chest' | 'waist' | 'hips' | 'arms' | 'legs'> = {
    weightKg: 'weight', chestCm: 'chest', waistCm: 'waist', hipsCm: 'hips', armsCm: 'arms', legsCm: 'legs',
  };

  function handleSave() {
    // v1.19 (LL#104) — only what the scale showed is stored; an empty field
    // is skipped, and an out-of-range one stops the save and says which.
    const scale: Partial<Record<ScaleKey, number>> = {};
    if (prefs.trackScale) {
      for (const m of SCALE_METRICS) {
        const v = parseScaleInput(m, form.scale[m.key], unit);
        if (v === null) { setScaleErr(m.key); return; }
        if (v !== undefined) scale[m.key] = v;
      }
    }
    setScaleErr(null);
    // A field still showing what was loaded keeps the stored value.
    const same = loaded && loaded.row.date === form.date ? loaded : null;
    const keep = (k: Basic, parsed: number | undefined) =>
      same && form[FIELD[k]] === same.form[FIELD[k]] ? same.row[k] : parsed;
    const payload = {
      ...scale,
      date: form.date,
      weightKg: keep('weightKg', parseWeightInputToKg(form.weight)),
      chestCm: prefs.trackChest ? keep('chestCm', parseLengthInputToCm(form.chest)) : undefined,
      waistCm: prefs.trackWaist ? keep('waistCm', parseLengthInputToCm(form.waist)) : undefined,
      hipsCm: prefs.trackHips ? keep('hipsCm', parseLengthInputToCm(form.hips)) : undefined,
      armsCm: prefs.trackArms ? keep('armsCm', parseLengthInputToCm(form.arms)) : undefined,
      legsCm: prefs.trackLegs ? keep('legsCm', parseLengthInputToCm(form.legs)) : undefined,
      notes: form.notes.trim() || undefined,
    };
    for (const k of Object.keys(LIMITS) as Basic[]) {
      const v = payload[k];
      if (v != null && v >= LIMITS[k]) {
        const max = k === 'weightKg'
          ? (isImperial ? Math.floor(kgToLb(LIMITS[k])) : LIMITS[k])
          : (isImperial ? Math.floor(cmToIn(LIMITS[k])) : LIMITS[k]);
        setFieldErr({ name: t(`body.${FIELD[k]}`), max });
        return;
      }
    }
    setFieldErr(null);
    // Suppress if nothing actually filled in.
    const filled =
      payload.weightKg != null ||
      payload.chestCm != null ||
      payload.waistCm != null ||
      payload.hipsCm != null ||
      payload.armsCm != null ||
      payload.legsCm != null ||
      Object.keys(scale).length > 0 ||
      payload.notes != null;
    if (!filled) return;
    addOrUpdate(payload);
    setForm(EMPTY_FORM);
    setLoaded(null);
  }

  function loadEntryIntoForm(date: string) {
    const row = metrics.find((m) => m.date === date);
    if (!row) return;
    setFieldErr(null);
    const next: FormState = {
      date: row.date,
      weight: row.weightKg != null
        ? String(isImperial ? kgToLb(row.weightKg).toFixed(1) : row.weightKg)
        : '',
      chest: row.chestCm != null
        ? String(isImperial ? cmToIn(row.chestCm).toFixed(1) : row.chestCm)
        : '',
      waist: row.waistCm != null
        ? String(isImperial ? cmToIn(row.waistCm).toFixed(1) : row.waistCm)
        : '',
      hips: row.hipsCm != null
        ? String(isImperial ? cmToIn(row.hipsCm).toFixed(1) : row.hipsCm)
        : '',
      arms: row.armsCm != null
        ? String(isImperial ? cmToIn(row.armsCm).toFixed(1) : row.armsCm)
        : '',
      legs: row.legsCm != null
        ? String(isImperial ? cmToIn(row.legsCm).toFixed(1) : row.legsCm)
        : '',
      scale: Object.fromEntries(SCALE_METRICS.map((m) => [m.key, scaleToInput(m, row[m.key], unit)])) as Record<ScaleKey, string>,
      notes: row.notes ?? '',
    };
    setForm(next);
    setLoaded({ row, form: next });
  }

  // v1.2.1 — native capture via @capacitor/camera.
  //
  // Why this and not <input type="file" capture="environment">:
  // the file-input path used `<input>` + WebChromeClient.onShowFileChooser
  // to launch the camera intent. On low-memory Android devices the OS often
  // kills LimeLog's process while the camera app is in the foreground —
  // when the user finishes capturing, MainActivity is recreated, the
  // WebView reloads index.html, the React tree mounts fresh, and the
  // ValueCallback registered for the file picker is gone with the prior
  // process. Net symptom: app appears to "reload to home" after capture
  // and the photo is silently dropped.
  //
  // @capacitor/camera persists the capture URI on the native side and
  // re-delivers the result on Activity recreation. v1.22 (limelog#125): that
  // result does NOT resolve this Promise after process death (it died with
  // the old WebView); it arrives as App's `appRestoredResult` event, which
  // lib/restoredResult.ts handles, saving for the day put in PHOTO_DATE_KEY
  // below. The plugin also applies width + quality at capture time, so we
  // skip the canvas resize on this path (savePhotoFromDataUrl bypasses it).
  //
  // Web path keeps using <input type="file"> + canvas pipeline — no
  // process-kill risk in a browser tab, and Capacitor.isNativePlatform()
  // gates the plugin call so non-Android builds don't fail at import.
  // v1.22 (limelog#126) — with the gallery full, a new day's photo deletes
  // the oldest. Said BEFORE the camera opens, with the chance to keep a copy
  // (Cancel, then save it) instead of a notice after it is gone.
  async function okToEvict(): Promise<boolean> {
    const oldest = photoToEvict(form.date);
    if (!oldest) return true;
    return confirm({
      title: t('body.photoFullTitle'),
      message: t('body.photoFullConfirm', { date: oldest }),
      confirmLabel: t('body.photoFullContinue'),
    });
  }

  async function handleSaveCopy(p: ProgressPhoto) {
    setPhotoNotice(null);
    try {
      const name = await savePhotoCopy(p);
      if (name) setPhotoNotice(t('body.photoCopySaved', { name }));
    } catch (err) {
      console.warn('[photos] save copy failed:', err);
      setPhotoNotice(t('body.photoCopyFailed'));
    }
  }

  async function capturePhotoNative() {
    setPhotoNotice(null);
    if (!(await okToEvict())) return;
    try {
      localStorage.setItem(PHOTO_DATE_KEY, form.date);
    } catch {
      /* without it a restored photo is saved for today */
    }
    try {
      const photo = await CapacitorCamera.getPhoto({
        quality: 72,
        width: 600,
        // Matches our existing canvas resize bounds. The plugin scales
        // the long edge to `width` while preserving aspect, identical to
        // the web canvas pipeline's `MAX_WIDTH=600`.
        allowEditing: false,
        // v1.7 (BUG-8) — Uri, NOT DataUrl. A DataUrl result keeps the full
        // base64 image alive in the WebView across the whole camera intent,
        // inflating our memory footprint exactly while the camera app is
        // foreground — which is what tips a low-memory Android device into
        // killing LimeLog's process (symptom: app "reopens to home" and the
        // flow is lost after capture). With Uri the plugin writes the resized
        // JPEG to a cache file and hands back a lightweight path, so the
        // WebView holds almost nothing during that window. We read the file
        // into a data URL only at save time, after we're safely back.
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
        saveToGallery: false,
        // promptLabelHeader is only shown when source is Prompt — we go
        // straight to camera here, so it's unused but harmless to omit.
      });
      const webPath = photo.webPath;
      if (!webPath) {
        // v1.18.1 (LimeLog#77) — this notice and the two below were English.
        setPhotoNotice(t('body.photoNoImage'));
        return;
      }
      const dataUrl = await photoDataUrlFromWebPath(webPath);
      const { evicted } = await savePhotoFromDataUrl(form.date, dataUrl);
      setPhotosNonce((n) => n + 1);
      if (evicted > 0) {
        setPhotoNotice(t('body.photosEvicted', { count: evicted }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof PhotoError) {
        setPhotoNotice(err.message);
        return;
      }
      // User-cancelled is the plugin's standard "User cancelled photos
      // app" error — silently no-op instead of flashing a scary message.
      if (/cancel/i.test(msg)) return;
      // v1.18.1 (LimeLog#82) — only a PhotoError's message is translated.
      // The plugin's and the fetch's are the platform's English.
      console.warn('[photos] capture failed:', msg);
      setPhotoNotice(t('body.photoSaveFailed'));
    } finally {
      // Back in the same process: this call handled it, not the restore path.
      try {
        localStorage.removeItem(PHOTO_DATE_KEY);
      } catch {
        /* nothing kept */
      }
    }
  }

  async function handlePhotoCapture(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoNotice(null);
    try {
      const { evicted } = await savePhoto(form.date, file);
      setPhotosNonce((n) => n + 1);
      if (evicted > 0) {
        setPhotoNotice(t('body.photosEvicted', { count: evicted }));
      }
    } catch (err) {
      // v1.18.1 (LimeLog#82) — a PhotoError's message is translated; any
      // other error's is not, so it gets the generic line.
      setPhotoNotice(err instanceof PhotoError ? err.message : t('body.photoSaveFailed'));
    }
    // Reset input so the same file path can be re-selected.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const useNativeCapture = Capacitor.isNativePlatform();

  async function handlePhotoDelete(p: ProgressPhoto) {
    if (!(await confirm({ message: t('body.deletePhotoConfirm', { date: p.date }) }))) return;
    // v1.18.1 (LimeLog#82) — the delete rewrites the photo index, which can
    // throw (a PhotoError); it escaped the click handler unseen.
    try {
      deletePhoto(p.date);
    } catch (err) {
      setPhotoNotice(err instanceof PhotoError ? err.message : t('body.photoSaveFailed'));
    }
    setPhotosNonce((n) => n + 1);
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="body-metrics-panel">
      {/* Unit + tracked-fields prefs */}
      <Card padding="md" className="body-metrics-prefs">
        <div className="body-metrics-prefs__row">
          <span className="body-metrics-prefs__label">{t('body.units')}</span>
          <div className="body-metrics-prefs__unit-toggle" role="radiogroup" aria-label={t('body.unitSystem')}>
            <button
              type="button"
              role="radio"
              aria-checked={unit === 'metric'}
              className={unit === 'metric' ? 'is-on' : ''}
              onClick={() => updatePrefs({ unitSystem: 'metric' })}
            >
              kg / cm
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={unit === 'imperial'}
              className={unit === 'imperial' ? 'is-on' : ''}
              onClick={() => updatePrefs({ unitSystem: 'imperial' })}
            >
              lb / in
            </button>
          </div>
        </div>
        <div className="body-metrics-prefs__row">
          <span className="body-metrics-prefs__label">{t('body.track')}</span>
          <div className="body-metrics-prefs__chips">
            {TRACK_OPTIONS.map((opt) => {
              const on = prefs[opt.key];
              return (
                <button
                  type="button"
                  key={opt.key}
                  aria-pressed={on}
                  className={`body-chip ${on ? 'is-on' : ''}`}
                  onClick={() => updatePrefs({ [opt.key]: !on })}
                >
                  {t(opt.labelKey)}
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      {/* v1.19 (LL#104) — height, its log and BMI. */}
      <HeightCard />

      {/* Log form */}
      <Card padding="md">
        <h3 className="body-metrics-section__title">{t('body.logEntry')}</h3>
        <div className="body-metrics-form">
          <label className="body-metrics-form__field">
            <span>{t('body.date')}</span>
            <input
              type="date"
              value={form.date}
              onChange={(e) => {
                const v = e.target.value;
                setForm((f) => ({ ...f, date: v }));
                loadEntryIntoForm(v);
              }}
            />
          </label>
          <label className="body-metrics-form__field">
            <span>{t('body.weight')} ({isImperial ? 'lb' : 'kg'})</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              placeholder={isImperial ? '180.0' : '82.5'}
              ref={weightRef}
              value={form.weight}
              onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))}
            />
          </label>
          {prefs.trackChest && (
            <label className="body-metrics-form__field">
              <span>{t('body.chest')} ({isImperial ? 'in' : 'cm'})</span>
              <input type="number" inputMode="decimal" step="0.1"
                value={form.chest}
                onChange={(e) => setForm((f) => ({ ...f, chest: e.target.value }))}
              />
            </label>
          )}
          {prefs.trackWaist && (
            <label className="body-metrics-form__field">
              <span>{t('body.waist')} ({isImperial ? 'in' : 'cm'})</span>
              <input type="number" inputMode="decimal" step="0.1"
                value={form.waist}
                onChange={(e) => setForm((f) => ({ ...f, waist: e.target.value }))}
              />
            </label>
          )}
          {prefs.trackHips && (
            <label className="body-metrics-form__field">
              <span>{t('body.hips')} ({isImperial ? 'in' : 'cm'})</span>
              <input type="number" inputMode="decimal" step="0.1"
                value={form.hips}
                onChange={(e) => setForm((f) => ({ ...f, hips: e.target.value }))}
              />
            </label>
          )}
          {prefs.trackArms && (
            <label className="body-metrics-form__field">
              <span>{t('body.arms')} ({isImperial ? 'in' : 'cm'})</span>
              <input type="number" inputMode="decimal" step="0.1"
                value={form.arms}
                onChange={(e) => setForm((f) => ({ ...f, arms: e.target.value }))}
              />
            </label>
          )}
          {prefs.trackLegs && (
            <label className="body-metrics-form__field">
              <span>{t('body.legs')} ({isImperial ? 'in' : 'cm'})</span>
              <input type="number" inputMode="decimal" step="0.1"
                value={form.legs}
                onChange={(e) => setForm((f) => ({ ...f, legs: e.target.value }))}
              />
            </label>
          )}
          {prefs.trackScale && (
            <>
              <div className="body-metrics-form__group">{t('body.scale.group')}</div>
              {SCALE_METRICS.map((m) => {
                const u = scaleUnit(m, unit);
                return (
                  <label key={m.key} className="body-metrics-form__field">
                    <span>{t(m.labelKey)}{u ? ` (${u})` : ''}</span>
                    <input
                      type="number"
                      inputMode={m.step >= 1 ? 'numeric' : 'decimal'}
                      step={m.step}
                      placeholder={`${scaleToInput(m, m.min, unit)}–${scaleToInput(m, m.max, unit)}`}
                      aria-invalid={scaleErr === m.key || undefined}
                      value={form.scale[m.key]}
                      onChange={(e) => { const v = e.target.value; setScaleErr(null); setForm((f) => ({ ...f, scale: { ...f.scale, [m.key]: v } })); }}
                    />
                  </label>
                );
              })}
              {scaleErr && (() => {
                const m = SCALE_METRICS.find((x) => x.key === scaleErr)!;
                return <p className="body-metrics-error body-metrics-form__field--full" role="alert">{t('body.scale.outOfRange', { name: t(m.labelKey), min: scaleToInput(m, m.min, unit), max: scaleToInput(m, m.max, unit) })}</p>;
              })()}
            </>
          )}
          {fieldErr && (
            <p className="body-metrics-error body-metrics-form__field--full" role="alert">
              {t('body.scale.outOfRange', { name: fieldErr.name, min: 0, max: fieldErr.max })}
            </p>
          )}
          <label className="body-metrics-form__field body-metrics-form__field--full">
            <span>{t('body.notes')}</span>
            <textarea
              rows={2}
              placeholder={t('body.notesPlaceholder')}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </label>
        </div>
        <Button variant="primary" fullWidth onClick={handleSave}>
          {t('body.saveEntry')}
        </Button>
      </Card>

      {/* v1.19 (LL#104) — a chart per smart-scale metric that has readings. */}
      <ScaleTrendsCard />

      {/* Trend chart — suppressed when the page renders its own summary card
          (BodyMetricsSummaryCard) so we don't show two weight charts. */}
      {showTrend && (
      <Card padding="md">
        <div className="body-metrics-section__header">
          <h3 className="body-metrics-section__title">{t('body.weightTrend')}</h3>
          {trend30 && (
            <span
              className={`body-metrics-trend-pill ${
                trend30.deltaKg < -0.2
                  ? 'is-down'
                  : trend30.deltaKg > 0.2
                    ? 'is-up'
                    : 'is-flat'
              }`}
            >
              {trend30.deltaKg > 0 ? '+' : ''}
              {isImperial
                ? `${kgToLb(trend30.deltaKg).toFixed(1)} lb`
                : `${trend30.deltaKg.toFixed(1)} kg`}{' '}
              {t('body.overDays', { days: trend30.days })}
            </span>
          )}
        </div>
        {series.length === 0 ? (
          <p className="body-metrics-empty">
            {t('body.logToSeeTrend')}
          </p>
        ) : (
          <WeightChart series={series} isImperial={isImperial} />
        )}
      </Card>
      )}

      {/* Recent entries */}
      {sorted.length > 0 && (
        <Card padding="md">
          <h3 className="body-metrics-section__title">{t('body.recentEntries')}</h3>
          <div className="body-metrics-list">
            {sorted.slice(0, 10).map((row) => (
              <div key={row.id} className="body-metrics-list__row">
                <div className="body-metrics-list__date">{row.date}</div>
                <div className="body-metrics-list__values">
                  {row.weightKg != null && (
                    <span>{formatWeight(row.weightKg, unit)}</span>
                  )}
                  {row.waistCm != null && (
                    <span className="body-metrics-list__meta">
                      {t('body.waist')} {formatLength(row.waistCm, unit)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="body-metrics-list__delete"
                  aria-label={t('body.deleteEntryConfirm', { date: row.date })}
                  onClick={async () => {
                    if (await confirm({ message: t('body.deleteEntryConfirm', { date: row.date }) })) {
                      remove(row.id);
                    }
                  }}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Photos */}
      <Card padding="md">
        <div className="body-metrics-section__header">
          <h3 className="body-metrics-section__title">{t('body.progressPhotos')}</h3>
          <span className="body-metrics-section__subtle">{t('body.localOnly')}</span>
        </div>
        <div className="body-metrics-photo-capture">
          {useNativeCapture ? (
            // v1.2.1 — native capture button. Uses @capacitor/camera so the
            // capture survives process kill while the camera app is in the
            // foreground (Android low-memory devices were silently losing
            // photos via the <input type="file"> path).
            <button
              type="button"
              className="body-metrics-photo-label"
              onClick={capturePhotoNative}
            >
              <Camera size={14} aria-hidden /> {t('body.captureFor', { date: form.date })}
            </button>
          ) : (
            <>
              <input
                ref={fileInputRef}
                id="body-metrics-photo-input"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePhotoCapture}
                onClick={(e) => {
                  // v1.22 (limelog#126): ask before the picker when full.
                  if (!photoToEvict(form.date)) return;
                  e.preventDefault();
                  void okToEvict().then((ok) => ok && fileInputRef.current?.click());
                }}
                className="body-metrics-photo-input"
              />
              <label htmlFor="body-metrics-photo-input" className="body-metrics-photo-label">
                <Camera size={14} aria-hidden /> {t('body.captureFor', { date: form.date })}
              </label>
            </>
          )}
          {photoForFormDate && (
            <span className="body-metrics-photo-existing">
              {t('body.photoOverwrite')}
            </span>
          )}
        </div>
        {photoNotice && (
          <div className="body-metrics-photo-notice" role="status">
            {photoNotice}
          </div>
        )}
        {photos.length === 0 ? (
          <p className="body-metrics-empty">
            {t('body.noPhotos')}
          </p>
        ) : (
          <div className="body-metrics-photo-grid">
            {photos.map((p) => (
              <figure key={p.date} className="body-metrics-photo">
                <img src={p.dataUrl} alt={t('body.photoAlt', { date: p.date })} loading="lazy" />
                <figcaption className="body-metrics-photo__caption">
                  {p.date}
                  <button
                    type="button"
                    className="body-metrics-photo__delete"
                    aria-label={t('body.savePhotoCopy', { date: p.date })}
                    title={t('body.savePhotoCopy', { date: p.date })}
                    onClick={() => void handleSaveCopy(p)}
                  >
                    <Download size={12} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="body-metrics-photo__delete"
                    aria-label={t('body.deletePhotoConfirm', { date: p.date })}
                    onClick={() => handlePhotoDelete(p)}
                  >
                    <Trash2 size={12} aria-hidden />
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── WeightChart ────────────────────────────────────────────────────────────
//
// Inline SVG line chart for the weight series + 7d MA overlay. No
// third-party charting lib — keeps the bundle slim and matches the LoadChart
// / OneRMChart pattern already in the codebase.

interface WeightChartProps {
  series: ReturnType<typeof weightSeries>;
  isImperial: boolean;
}

function WeightChart({ series, isImperial }: WeightChartProps) {
  const { t } = useTranslation();
  const w = 320;
  const h = 140;
  const padL = 24;
  const padR = 8;
  const padT = 12;
  const padB = 22;

  // Limit to last 90 entries so the chart stays readable.
  const data = series.slice(-90);
  const xs = data.map((_, i) => i);
  const ys = data.map((p) => p.weightKg);
  const minY = Math.min(...ys) - 0.5;
  const maxY = Math.max(...ys) + 0.5;
  const xRange = Math.max(1, xs.length - 1);
  const yRange = Math.max(0.5, maxY - minY);

  function scaleX(i: number): number {
    return padL + (i / xRange) * (w - padL - padR);
  }
  function scaleY(v: number): number {
    return padT + (1 - (v - minY) / yRange) * (h - padT - padB);
  }

  const linePath = data
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(i)},${scaleY(p.weightKg)}`)
    .join(' ');
  const maPath = data
    .filter((p) => p.ma7 != null)
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(data.indexOf(p))},${scaleY(p.ma7!)}`)
    .join(' ');

  const displayMin = isImperial ? kgToLb(minY).toFixed(0) : minY.toFixed(0);
  const displayMax = isImperial ? kgToLb(maxY).toFixed(0) : maxY.toFixed(0);

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      className="body-metrics-chart"
      role="img"
      aria-label={t('body.weightChart')}
    >
      <text x={padL - 4} y={padT + 4} className="body-metrics-chart__axis" textAnchor="end">
        {displayMax}
      </text>
      <text x={padL - 4} y={h - padB} className="body-metrics-chart__axis" textAnchor="end">
        {displayMin}
      </text>
      <path d={linePath} fill="none" className="body-metrics-chart__line" />
      {maPath && <path d={maPath} fill="none" className="body-metrics-chart__ma" />}
    </svg>
  );
}
