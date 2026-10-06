-- =============================================================================
-- 0030_production_reports.sql
-- Production department read-only report screens (Laser / Bending / Fabrication)
--
-- Contains:
--   1) 6 report tables (schema frozen)
--   2) Indexes on every date/month/machine column the screens query
--   3) RLS: SELECT-only for signed-in users; NO write policies at all
--      (writes happen exclusively via the service-role Edge Function)
--   4) report_targets seeds (laser ₹/kg, fabrication ₹/piece)
--   5) Private Storage bucket `production-excel` for the monthly Excel files
--
-- Grain (row meaning):
--   laser_production   = date x machine x thickness
--   laser_outsource    = date x one outsource weight row
--   laser_manpower     = date x machine x shift
--   bending_daily      = date x machine x shift
--   fabrication_daily  = date x station x part
--
-- `source_month` is the ingest bookkeeping column, format 'YYYY-MM'.
-- Ingest replaces a month with: DELETE ... WHERE source_month = 'YYYY-MM'
--                               then INSERT for the whole file.
--
-- AFTER RUNNING THIS FILE: deploy Edge Function `ingest-production-excel`,
-- then create the storage webhook (Dashboard -> Integrations -> Database
-- Webhooks: table storage.objects, event INSERT,
-- filter bucket_id = 'production-excel' -> invoke ingest-production-excel).
-- Screens and app code never write to these tables.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. LASER (production data — July+ layout; older months add shift/operator
--    as NULL, the screens simply hide sections whose columns are all NULL)
-- -----------------------------------------------------------------------------
create table if not exists public.laser_production (
  id            bigint generated always as identity primary key,
  work_date     date        not null,
  source_month  text        not null,          -- 'YYYY-MM'
  machine       text        not null,          -- L-1 .. L-4
  shift         text,                          -- 'A' / 'B' (nullable)
  operator      text,
  thickness_mm  numeric,
  sheets        integer,
  periphery_mmm numeric,                       -- thousand-mm (₹ / M-MM basis)
  weight_kg     numeric,
  created_at    timestamptz not null default now()
);

comment on table public.laser_production is
  'Laser daily production. Grain: work_date x machine x thickness. Read-only for clients.';
comment on column public.laser_production.periphery_mmm is
  'Cut length in thousand mm (M-MM); denominator of the ₹ / M-MM KPI.';

-- Outsource weights (the grey OUT bar + "incl. outsource" KPI)
create table if not exists public.laser_outsource (
  id            bigint generated always as identity primary key,
  work_date     date        not null,
  source_month  text        not null,          -- 'YYYY-MM'
  weight_kg     numeric     not null,
  created_at    timestamptz not null default now()
);

comment on table public.laser_outsource is
  'Daily outsourced cutting weight. Read-only for clients.';

-- Per-machine manpower cost (feeding cost, ₹/kg, ₹/M-MM KPIs)
create table if not exists public.laser_manpower (
  id            bigint generated always as identity primary key,
  work_date     date        not null,
  source_month  text        not null,          -- 'YYYY-MM'
  machine       text        not null,          -- L-1 .. L-4
  shift         text,                          -- 'A' / 'B' / null
  cost_inr      numeric     not null,
  created_at    timestamptz not null default now()
);

comment on table public.laser_manpower is
  'Daily manpower/feeding cost per machine per shift. Read-only for clients.';


-- -----------------------------------------------------------------------------
-- 2. BENDING — machine breakdown + downtime source
-- -----------------------------------------------------------------------------
create table if not exists public.bending_daily (
  id             bigint generated always as identity primary key,
  work_date      date        not null,
  source_month   text        not null,         -- 'YYYY-MM'
  machine        text        not null,         -- B-1, B-2, B-3/4, B-4 (verbatim from Excel)
  shift          text,                         -- 'A' / 'B' / null
  operator       text,
  capacity       text,                         -- e.g. '135T' — kept text, display only
  strokes        integer,
  weight_kg      numeric,
  manpower_cost  numeric,
  remark         text,                         -- DOWNTIME SOURCE (see below)
  created_at     timestamptz not null default now()
);

comment on table public.bending_daily is
  'Bending daily production. Grain: work_date x machine x shift. Read-only for clients.';
comment on column public.bending_daily.remark is
  'Downtime KPI = count of work_days per machine per month where remark is non-empty
   (Sundays excluded — mirrors the original dashboard logic).';


-- -----------------------------------------------------------------------------
-- 3. FABRICATION — station breakdown
-- -----------------------------------------------------------------------------
create table if not exists public.fabrication_daily (
  id              bigint generated always as identity primary key,
  work_date       date        not null,
  source_month    text        not null,        -- 'YYYY-MM'
  station         text        not null,        -- Mahindra / Metso Machine / Mesto Station
  part_no         text,
  unit_weight_kg  numeric,
  -- Preserve the Excel value exactly.  The legacy dashboard rounds each raw
  -- row only when it calculates piece totals.
  quantity        numeric,
  weight_kg       numeric,
  manpower_cost   numeric,
  created_at      timestamptz not null default now()
);

comment on table public.fabrication_daily is
  'Fabrication daily production. Grain: work_date x station x part. Read-only for clients.';


-- -----------------------------------------------------------------------------
-- 4. REPORT TARGETS (the "target ≤ 0.93 ✅" lines under KPI tiles)
-- -----------------------------------------------------------------------------
create table if not exists public.report_targets (
  id             bigint generated always as identity primary key,
  dept           text        not null,         -- 'laser' | 'bending' | 'fabrication'
  metric         text        not null,         -- 'rs_per_kg' | 'rs_per_piece' | ...
  target_value   numeric     not null,
  effective_from date        not null default current_date,
  created_at     timestamptz not null default now(),
  unique (dept, metric, effective_from)
);

comment on table public.report_targets is
  'KPI target values shown under tiles. Read-only for clients.';

insert into public.report_targets (dept, metric, target_value, effective_from)
values
  ('laser',        'rs_per_kg',    0.93, date '2026-01-01'),
  ('fabrication',  'rs_per_piece', 2.40, date '2026-01-01')
on conflict (dept, metric, effective_from) do nothing;


-- -----------------------------------------------------------------------------
-- 5. INDEXES — every filter the screens use
-- -----------------------------------------------------------------------------
create index if not exists laser_production_work_date_idx     on public.laser_production (work_date);
create index if not exists laser_production_source_month_idx  on public.laser_production (source_month);
create index if not exists laser_production_machine_idx       on public.laser_production (machine);

create index if not exists laser_outsource_work_date_idx      on public.laser_outsource (work_date);
create index if not exists laser_outsource_source_month_idx   on public.laser_outsource (source_month);

create index if not exists laser_manpower_work_date_idx       on public.laser_manpower (work_date);
create index if not exists laser_manpower_source_month_idx    on public.laser_manpower (source_month);
create index if not exists laser_manpower_machine_idx         on public.laser_manpower (machine);

create index if not exists bending_daily_work_date_idx        on public.bending_daily (work_date);
create index if not exists bending_daily_source_month_idx     on public.bending_daily (source_month);
create index if not exists bending_daily_machine_idx          on public.bending_daily (machine);

create index if not exists fabrication_daily_work_date_idx    on public.fabrication_daily (work_date);
create index if not exists fabrication_daily_source_month_idx on public.fabrication_daily (source_month);
create index if not exists fabrication_daily_station_idx      on public.fabrication_daily (station);


-- -----------------------------------------------------------------------------
-- 6. RLS — every signed-in user may READ; nobody may write from a client.
--    (No INSERT/UPDATE/DELETE policies exist => app is read-only by design.)
-- -----------------------------------------------------------------------------
alter table public.laser_production   enable row level security;
alter table public.laser_outsource    enable row level security;
alter table public.laser_manpower     enable row level security;
alter table public.bending_daily      enable row level security;
alter table public.fabrication_daily  enable row level security;
alter table public.report_targets     enable row level security;

drop policy if exists "authenticated_read" on public.laser_production;
create policy "authenticated_read" on public.laser_production
  for select to authenticated using (true);

drop policy if exists "authenticated_read" on public.laser_outsource;
create policy "authenticated_read" on public.laser_outsource
  for select to authenticated using (true);

drop policy if exists "authenticated_read" on public.laser_manpower;
create policy "authenticated_read" on public.laser_manpower
  for select to authenticated using (true);

drop policy if exists "authenticated_read" on public.bending_daily;
create policy "authenticated_read" on public.bending_daily
  for select to authenticated using (true);

drop policy if exists "authenticated_read" on public.fabrication_daily;
create policy "authenticated_read" on public.fabrication_daily
  for select to authenticated using (true);

drop policy if exists "authenticated_read" on public.report_targets;
create policy "authenticated_read" on public.report_targets
  for select to authenticated using (true);


-- -----------------------------------------------------------------------------
-- 7. STORAGE — private bucket for the monthly Excel uploads.
--    Uploads come from the Supabase Dashboard (service role bypasses RLS),
--    so no client-side storage policies are needed for v1.
--    If an in-app admin upload is ever added, grant authenticated INSERT here.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('production-excel', 'production-excel', false, null, null)
on conflict (id) do nothing;

-- DONE.
-- Verify: \dt public.*          -> 6 new tables
--         \d+ laser_production  -> 0 rows, RLS enabled, policy = authenticated_read
-- Next:   supabase/functions/ingest-production-excel (step 2 of the build plan)

