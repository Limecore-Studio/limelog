-- v1.19 (LL#104) — smart-scale metrics and a height log on body_metrics.
--
-- NOT YET APPLIED. Needs the owner's OK (P1: production, real users).
--
-- ── What this is for ──────────────────────────────────────────────────────────
--
-- From the Discord backlog: log what a smart scale shows (body fat, water,
-- protein, basal metabolism, visceral fat, bone mass, muscle, body age), a
-- place to set height, and a height LOG (some users are still growing).
-- BMI is calculated in the app from weight and height and is never stored.
--
-- ── Why columns on body_metrics and not a new table ───────────────────────────
--
-- Body data is already one row per (user, date): weight plus girths, upserted
-- by day, owned by LimeLog and read by NCC. Scale readings and height are more
-- of the same morning snapshot. A separate `metric/value` table would be a
-- second, divergent schema for the same thing, with a second sync path and a
-- second read path in NCC. A height log is simply the days that have a height.
--
-- ── Backward compatibility (P1) ───────────────────────────────────────────────
--
-- Additive only: nine nullable columns, no defaults, no rewrite of existing
-- rows. LimeLog's push updates only the columns it sends, so an older build
-- saving the same day never clears the new ones. NCC maps known columns and
-- ignores the rest. Nothing reads or writes these until a v1.19 build.
--
-- RLS: unchanged. The table's existing owner policy covers new columns.
-- Triggers: set_updated_at and zz_skip_noop_update are row-generic.
--
-- ── Bounds ────────────────────────────────────────────────────────────────────
--
-- Each check matches src/lib/bodyScale.ts exactly. They must stay equal: a
-- value the server refuses would retry in the outbox for ever. NULL passes.

alter table public.body_metrics
  add column if not exists height_cm       numeric(4,1),
  add column if not exists body_fat_pct    numeric(4,1),
  add column if not exists water_pct       numeric(4,1),
  add column if not exists protein_pct     numeric(4,1),
  add column if not exists bmr_kcal        integer,
  add column if not exists visceral_fat    numeric(3,1),
  add column if not exists bone_mass_kg    numeric(4,2),
  add column if not exists muscle_mass_kg  numeric(5,2),
  add column if not exists body_age        integer;

alter table public.body_metrics
  add constraint body_metrics_height_cm_range      check (height_cm      between 40  and 272),
  add constraint body_metrics_body_fat_pct_range   check (body_fat_pct   between 1   and 75),
  add constraint body_metrics_water_pct_range      check (water_pct      between 20  and 80),
  add constraint body_metrics_protein_pct_range    check (protein_pct    between 5   and 40),
  add constraint body_metrics_bmr_kcal_range       check (bmr_kcal       between 500 and 5000),
  add constraint body_metrics_visceral_fat_range   check (visceral_fat   between 1   and 60),
  add constraint body_metrics_bone_mass_kg_range   check (bone_mass_kg   between 0.5 and 10),
  add constraint body_metrics_muscle_mass_kg_range check (muscle_mass_kg between 5   and 150),
  add constraint body_metrics_body_age_range       check (body_age       between 5   and 120);
