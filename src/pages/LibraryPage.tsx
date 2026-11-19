import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useProgramStore } from '@/store/programStore';
import { useDeleteExercise } from '@/components/useDeleteExercise';
import { BUILTIN_EXERCISES } from '@/data/builtinExercises';
import type { MovementPattern, BuiltinMovementPattern, Equipment, BuiltinEquipment } from '@/types';
import { Button, Tabs, TabPanel } from '@/components/ui';
import { Plus, Trash2, Search, Dumbbell } from 'lucide-react';
import './LibraryPage.css';

const PATTERNS: BuiltinMovementPattern[] = ['push', 'pull', 'hinge', 'squat', 'carry', 'jump', 'core', 'accessory'];
const EQUIPMENT: BuiltinEquipment[] = ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'band', 'kettlebell', 'other'];

// Sentinel for the "type your own" option in the two dropdowns. Not a valid
// stored value — picking it swaps the select for a text input.
const CUSTOM = '__custom__';

type Tab = 'my' | 'browse';

function matchesFilter(
  name: string,
  muscle: string,
  pattern: MovementPattern,
  equip: Equipment,
  search: string,
  filterPattern: MovementPattern | 'all',
  filterEquip: Equipment | 'all',
) {
  const matchSearch = !search
    || name.toLowerCase().includes(search.toLowerCase())
    || muscle.toLowerCase().includes(search.toLowerCase());
  const matchPattern = filterPattern === 'all' || pattern === filterPattern;
  const matchEquip = filterEquip === 'all' || equip === filterEquip;
  return matchSearch && matchPattern && matchEquip;
}

export function LibraryPage() {
  const { t } = useTranslation();
  const { exercises: stored, addExercise } = useProgramStore();
  // v1.22 (limelog#122): archived exercises are kept for history, not listed.
  const exercises = useMemo(() => stored.filter((e) => !e.archived), [stored]);
  const deleteExercise = useDeleteExercise();
  // defaultValue keeps a user's own wording intact — without it a custom
  // pattern rendered as the raw key, "library.pattern.sandbag".
  const patternLabel = (p: MovementPattern) => t(`library.pattern.${p}`, { defaultValue: p });
  const equipLabel = (e: Equipment) => t(`library.equip.${e}`, { defaultValue: e });

  const [tab, setTab] = useState<Tab>('my');
  const [search, setSearch] = useState('');
  const [filterPattern, setFilterPattern] = useState<MovementPattern | 'all'>('all');
  const [filterEquip, setFilterEquip] = useState<Equipment | 'all'>('all');

  // Custom exercise form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: '', movementPattern: 'squat' as MovementPattern,
    primaryMuscle: '', equipment: 'dumbbell' as Equipment, isBilateral: true,
  });
  // Whether each dropdown has been swapped for its free-text input (A7).
  const [patternIsCustom, setPatternIsCustom] = useState(false);
  const [equipIsCustom, setEquipIsCustom] = useState(false);

  const builtinNames = useMemo(() => new Set(BUILTIN_EXERCISES.map((e) => e.name)), []);

  // Any pattern/equipment value in the library that is not one of the eight.
  // Without these the filter dropdowns could not reach a custom-filed exercise.
  const extraPatterns = useMemo(
    () => [...new Set(exercises.map((e) => e.movementPattern))]
      .filter((p) => !(PATTERNS as string[]).includes(p)).sort(),
    [exercises],
  );
  const extraEquipment = useMemo(
    () => [...new Set(exercises.map((e) => e.equipment))]
      .filter((e) => !(EQUIPMENT as string[]).includes(e)).sort(),
    [exercises],
  );
  const inStoreNames = useMemo(() => new Set(exercises.map((e) => e.name)), [exercises]);

  // "My Library" tab: all exercises currently in store
  const myExercises = useMemo(() => {
    return exercises.filter((e) =>
      matchesFilter(e.name, e.primaryMuscle, e.movementPattern, e.equipment, search, filterPattern, filterEquip)
    );
  }, [exercises, search, filterPattern, filterEquip]);

  // "Browse" tab: all builtins not yet in store
  const browseExercises = useMemo(() => {
    return BUILTIN_EXERCISES.filter((e) =>
      !inStoreNames.has(e.name) &&
      matchesFilter(e.name, e.primaryMuscle, e.movementPattern, e.equipment, search, filterPattern, filterEquip)
    );
  }, [inStoreNames, search, filterPattern, filterEquip]);

  // Unfiltered count for tab badge
  const browseTotalCount = useMemo(
    () => BUILTIN_EXERCISES.filter((e) => !inStoreNames.has(e.name)).length,
    [inStoreNames]
  );

  function handleAddBuiltin(ex: typeof BUILTIN_EXERCISES[number]) {
    addExercise(ex);
  }

  function handleAddCustom() {
    if (!form.name.trim()) return;
    // A blank free-text box falls back to the nearest built-in catch-all rather
    // than storing an empty string, which would render as a bare separator dot.
    const movementPattern = form.movementPattern.trim() || 'accessory';
    const equipment = form.equipment.trim() || 'other';
    addExercise({
      ...form,
      name: form.name.trim(),
      primaryMuscle: form.primaryMuscle.trim(),
      movementPattern,
      equipment,
    });
    setForm({ name: '', movementPattern: 'squat', primaryMuscle: '', equipment: 'dumbbell', isBilateral: true });
    setPatternIsCustom(false);
    setEquipIsCustom(false);
    setShowForm(false);
  }

  const customCount = exercises.filter((e) => !builtinNames.has(e.name)).length;

  return (
    <div className="lib-page">
      <div className="lib-page__header">
        <div className="lib-page__title-row">
          <Dumbbell size={20} aria-hidden="true" />
          <h1 className="lib-page__title">{t('library.title')}</h1>
        </div>
        <p className="lib-page__subtitle">
          {t('library.inLibrary', { count: exercises.length })}
          {customCount > 0 && ` · ${t('library.customCount', { count: customCount })}`}
        </p>
      </div>

      {/* ── Tabs ── */}
      <Tabs
        tabs={[
          { key: 'my', label: t('library.tabMy'), count: exercises.length },
          { key: 'browse', label: t('library.tabBrowse'), count: browseTotalCount },
        ]}
        activeKey={tab}
        onChange={(k) => setTab(k as Tab)}
      />

      {/* ── Search + Filters ── */}
      <div className="lib-page__controls">
        <div className="lib-page__search-wrap">
          <Search size={13} className="lib-page__search-icon" aria-hidden="true" />
          <input
            className="lib-page__search"
            placeholder={t('library.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('library.searchAria')}
          />
        </div>
        <div className="lib-page__filters">
          <select
            aria-label={t('library.filterPatternAria')}
            value={filterPattern}
            onChange={(e) => setFilterPattern(e.target.value as MovementPattern | 'all')}
          >
            <option value="all">{t('library.allPatterns')}</option>
            {PATTERNS.map((p) => <option key={p} value={p}>{patternLabel(p)}</option>)}
            {extraPatterns.map((p) => <option key={p} value={p}>{patternLabel(p)}</option>)}
          </select>
          <select
            aria-label={t('library.filterEquipAria')}
            value={filterEquip}
            onChange={(e) => setFilterEquip(e.target.value as Equipment | 'all')}
          >
            <option value="all">{t('library.allEquipment')}</option>
            {EQUIPMENT.map((e) => <option key={e} value={e}>{equipLabel(e)}</option>)}
            {extraEquipment.map((e) => <option key={e} value={e}>{equipLabel(e)}</option>)}
          </select>
          {(search || filterPattern !== 'all' || filterEquip !== 'all') && (
            <button
              className="lib-page__reset"
              onClick={() => { setSearch(''); setFilterPattern('all'); setFilterEquip('all'); }}
            >
              {t('library.clear')}
            </button>
          )}
        </div>
      </div>

      {/* ── MY LIBRARY TAB ── */}
      <TabPanel tabKey="my" activeKey={tab}>
        <div className="lib-page__list">
          <div className="lib-page__list-header">
            <Button size="sm" variant="primary" onClick={() => setShowForm((v) => !v)}>
              <Plus size={13} aria-hidden="true" /> {t('library.newCustom')}
            </Button>
          </div>

          {showForm && (
            <div className="lib-page__form">
              <input placeholder={t('library.namePlaceholder')} value={form.name} autoFocus
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              <input placeholder={t('library.primaryMusclePlaceholder')} value={form.primaryMuscle}
                onChange={(e) => setForm((f) => ({ ...f, primaryMuscle: e.target.value }))} />
              <select
                aria-label={t('library.filterPatternAria')}
                value={patternIsCustom ? CUSTOM : form.movementPattern}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === CUSTOM) { setPatternIsCustom(true); setForm((f) => ({ ...f, movementPattern: '' })); }
                  else { setPatternIsCustom(false); setForm((f) => ({ ...f, movementPattern: v })); }
                }}
              >
                {PATTERNS.map((p) => <option key={p} value={p}>{patternLabel(p)}</option>)}
                <option value={CUSTOM}>{t('library.customOption')}</option>
              </select>
              {patternIsCustom && (
                <input
                  placeholder={t('library.customPatternPlaceholder')}
                  value={form.movementPattern}
                  onChange={(e) => setForm((f) => ({ ...f, movementPattern: e.target.value }))}
                />
              )}
              <select
                aria-label={t('library.filterEquipAria')}
                value={equipIsCustom ? CUSTOM : form.equipment}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === CUSTOM) { setEquipIsCustom(true); setForm((f) => ({ ...f, equipment: '' })); }
                  else { setEquipIsCustom(false); setForm((f) => ({ ...f, equipment: v })); }
                }}
              >
                {EQUIPMENT.map((e) => <option key={e} value={e}>{equipLabel(e)}</option>)}
                <option value={CUSTOM}>{t('library.customOption')}</option>
              </select>
              {equipIsCustom && (
                <input
                  placeholder={t('library.customEquipPlaceholder')}
                  value={form.equipment}
                  onChange={(e) => setForm((f) => ({ ...f, equipment: e.target.value }))}
                />
              )}
              <label className="lib-page__bilateral">
                <input type="checkbox" checked={form.isBilateral}
                  onChange={(e) => setForm((f) => ({ ...f, isBilateral: e.target.checked }))} />
                {t('library.bilateral')}
              </label>
              <div className="lib-page__form-actions">
                <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>{t('common.cancel')}</Button>
                <Button size="sm" variant="primary" onClick={handleAddCustom} disabled={!form.name.trim()}>{t('common.add')}</Button>
              </div>
            </div>
          )}

          {myExercises.length === 0 && !showForm && (
            <p className="lib-page__empty">
              {exercises.length === 0
                ? t('library.emptyNoneMy')
                : t('library.emptyNoFilter')}
            </p>
          )}

          {myExercises.map((ex) => {
            const isCustom = !builtinNames.has(ex.name);
            return (
              <div key={ex.id} className="lib-page__item">
                <div className="lib-page__item-left">
                  <div className="lib-page__item-name-row">
                    <span className="lib-page__item-name">{ex.name}</span>
                    {isCustom && <span className="lib-page__item-badge">{t('library.custom')}</span>}
                  </div>
                  <span className="lib-page__item-meta">
                    {patternLabel(ex.movementPattern as MovementPattern)} · {equipLabel(ex.equipment as Equipment)}
                    {ex.primaryMuscle && ` · ${ex.primaryMuscle}`}
                  </span>
                </div>
                <button
                  className="lib-page__item-del"
                  onClick={() => void deleteExercise(ex)}
                  aria-label={t('library.removeAria', { name: ex.name })}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      </TabPanel>

      {/* ── BROWSE TAB ── */}
      <TabPanel tabKey="browse" activeKey={tab}>
        <div className="lib-page__list">
          {browseExercises.length === 0 && (
            <p className="lib-page__empty">
              {BUILTIN_EXERCISES.every((e) => inStoreNames.has(e.name))
                ? t('library.emptyAllAdded')
                : t('library.emptyNoFilter')}
            </p>
          )}
          {browseExercises.map((ex) => (
            <div key={ex.name} className="lib-page__item">
              <div className="lib-page__item-left">
                <span className="lib-page__item-name">{ex.name}</span>
                <span className="lib-page__item-meta">
                  {patternLabel(ex.movementPattern)} · {equipLabel(ex.equipment)}
                  {ex.primaryMuscle && ` · ${ex.primaryMuscle}`}
                </span>
              </div>
              <button
                className="lib-page__item-add"
                onClick={() => handleAddBuiltin(ex)}
                aria-label={t('library.addAria', { name: ex.name })}
              >
                <Plus size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      </TabPanel>
    </div>
  );
}
