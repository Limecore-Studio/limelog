// v1.9 (Item 4) — logging a run, ride or swim.
// v1.10 — and a basketball practice, a match, a dojo session. Same form,
// because the shape a training session needs is the shape this already had:
// duration, no sets, optional notes. The group toggle exists so training is
// not filed as "Cardio: other" — that stored a practice inside the cardio
// statistics, which is a different claim about the session than the user made.
//
// Deliberately not the workout logger with a type tag bolted on. That screen is
// built around sets and reps, and a run has neither — it has a duration and
// sometimes a distance. This is its own small form: pick the activity, say how
// long, optionally how far, save. There is no in-progress state to enter,
// because cardio is recorded after the fact rather than lived through in the
// app.
//
// Distance is shown only for activities where it means something. A basketball
// game has a duration but no sensible distance, so the field disappears rather
// than sitting there as an empty box the user has to decide about.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLogStore } from '@/store/logStore';
import { isFutureMoment, localParts, momentFromLocal } from '@/lib/sessionMoment';
import { useUserStore } from '@/store/userStore';
import {
  ACTIVITY_GROUPS,
  ACTIVITIES_BY_GROUP,
  activityTakesDistance,
  type ActivityGroup,
  type CardioActivity,
} from '@/types/logging';
import { Button } from '@/components/ui';
import { X } from 'lucide-react';
import './CardioLogModal.css';

interface Props {
  onClose: () => void;
}

export function CardioLogModal({ onClose }: Props) {
  const { t } = useTranslation();
  const { logCardio } = useLogStore();
  const unit = useUserStore((s) => s.profile.unitPreference);

  const [group, setGroup] = useState<ActivityGroup>('cardio');
  const [activity, setActivity] = useState<CardioActivity>('run');

  // Switching group moves the selection to that group's first entry rather
  // than keeping a now-hidden one. Leaving it would let someone switch to
  // Training, see nothing selected, hit Save and store a run.
  const pickGroup = (g: ActivityGroup) => {
    if (g === group) return;
    setGroup(g);
    setActivity(ACTIVITIES_BY_GROUP[g][0]);
  };
  const [minutes, setMinutes] = useState('');
  const [distance, setDistance] = useState('');
  const [notes, setNotes] = useState('');
  // v1.19 (LL#103) — when it happened, defaulting to now. Yesterday's run can
  // be logged on yesterday; a future one cannot be logged at all.
  const [opened] = useState(() => localParts(new Date()));
  const [date, setDate] = useState(opened.date);
  const [time, setTime] = useState(opened.time);
  const when = momentFromLocal(date, time);
  const inFuture = when !== null && isFutureMoment(when);

  const showsDistance = activityTakesDistance(activity);
  // Imperial users think in miles, metric users in kilometres — the same
  // preference that already drives kg vs lb. See formatDistance.
  const distanceUnit = unit === 'lb' ? 'mi' : 'km';
  const mins = parseFloat(minutes);
  const canSave = !isNaN(mins) && mins > 0 && when !== null && !inFuture;

  function handleSave() {
    if (!canSave) return;
    const dist = parseFloat(distance);
    logCardio({
      activityType: activity,
      durationSeconds: Math.round(mins * 60),
      // Stored in metres regardless of what was typed, so the database has one
      // unit and only the display layer ever converts.
      distanceMeters:
        showsDistance && !isNaN(dist) && dist > 0
          ? Math.round(dist * (unit === 'lb' ? 1609.344 : 1000))
          : undefined,
      notes: notes.trim() || undefined,
      when: when ?? undefined,
    });
    onClose();
  }

  return (
    <div className="cardio-modal-backdrop" onClick={onClose}>
      <div
        className="cardio-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('cardio.title')}
      >
        <div className="cardio-modal__header">
          <span className="cardio-modal__title">{t('cardio.title')}</span>
          <button className="cardio-modal__close" onClick={onClose} aria-label={t('common.cancel')}>
            <X size={18} />
          </button>
        </div>

        <div className="cardio-modal__body">
          {/* `cardio.activity` is the namespace holding the activity names, so
              the field's own label is a separate key rather than a collision. */}
          <div className="cardio-modal__groups" role="tablist" aria-label={t('cardio.activityLabel')}>
            {ACTIVITY_GROUPS.map((g) => (
              <button
                key={g}
                type="button"
                role="tab"
                aria-selected={group === g}
                className={`cardio-modal__group${group === g ? ' cardio-modal__group--active' : ''}`}
                onClick={() => pickGroup(g)}
              >
                {t(`cardio.group.${g}`)}
              </button>
            ))}
          </div>

          <span className="cardio-modal__label">{t('cardio.activityLabel')}</span>
          <div className="cardio-modal__activities">
            {ACTIVITIES_BY_GROUP[group].map((a) => (
              <button
                key={a}
                type="button"
                className={`cardio-modal__activity${activity === a ? ' cardio-modal__activity--active' : ''}`}
                aria-pressed={activity === a}
                onClick={() => setActivity(a)}
              >
                {t(`cardio.activity.${a}`)}
              </button>
            ))}
          </div>

          <label className="cardio-modal__label">
            {t('cardio.duration')}
            <input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              placeholder={t('cardio.durationPh')}
              autoFocus
            />
          </label>

          {showsDistance && (
            <label className="cardio-modal__label">
              {t('cardio.distance', { unit: distanceUnit })}
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.1"
                value={distance}
                onChange={(e) => setDistance(e.target.value)}
                placeholder={t('cardio.distancePh')}
              />
            </label>
          )}

          <span className="cardio-modal__label">{t('cardio.when')}</span>
          <div className="cardio-modal__when">
            <input
              type="date"
              value={date}
              max={opened.date}
              onChange={(e) => setDate(e.target.value)}
              aria-label={t('cardio.whenDate')}
            />
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              aria-label={t('cardio.whenTime')}
            />
          </div>
          {inFuture && <span className="cardio-modal__error" role="alert">{t('cardio.whenFuture')}</span>}

          <label className="cardio-modal__label">
            {t('cardio.notes')}
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('cardio.notesPh')}
            />
          </label>
        </div>

        <div className="cardio-modal__footer">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={!canSave}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
