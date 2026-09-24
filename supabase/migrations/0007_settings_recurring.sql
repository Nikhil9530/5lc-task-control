-- ============================================================================
-- 5LC TASK CONTROL - 0007 SYSTEM SETTINGS + RECURRING TASKS
-- Escalation thresholds are CONFIGURABLE (blueprint rule: never hard-coded).
-- ============================================================================

create table if not exists public.system_settings (
  id                        int primary key default 1 check (id = 1),
  -- Quiet hours: suppress non-urgent sends overnight (24h clock, company TZ).
  quiet_hours_start         int not null default 22,
  quiet_hours_end           int not null default 7,
  -- Days-overdue thresholds at which each level is notified.
  escalate_day_manager      int not null default 1,
  escalate_day_head         int not null default 2,
  escalate_day_director     int not null default 3,
  -- Urgent tasks escalate faster (in days).
  urgent_escalate_day_head     int not null default 0,
  urgent_escalate_day_director int not null default 1,
  -- Feature switches.
  email_enabled             boolean not null default true,
  push_enabled              boolean not null default true,
  timezone                  text not null default 'Asia/Kolkata',
  updated_at                timestamptz not null default now()
);

insert into public.system_settings (id) values (1) on conflict (id) do nothing;

alter table public.system_settings enable row level security;

-- Everyone may read settings (needed for display); only Super Admin may change.
drop policy if exists settings_select on public.system_settings;
create policy settings_select on public.system_settings for select using (true);

drop policy if exists settings_admin_write on public.system_settings;
create policy settings_admin_write on public.system_settings for all
  using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

-- ----------------------------------------------------------------------------
-- RECURRING TASK TEMPLATES
-- A scheduler creates a normal task per occurrence (each with its own history).
-- ----------------------------------------------------------------------------
create table if not exists public.recurring_tasks (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  assigned_to   uuid not null references public.profiles (id) on delete cascade,
  assigned_by   uuid references public.profiles (id) on delete set null,
  priority      text not null default 'normal'
                  check (priority in ('low','normal','high','urgent')),
  frequency     text not null default 'weekly'
                  check (frequency in ('daily','weekly','monthly')),
  -- ISO date the recurrence starts / ends (null end = runs forever).
  start_date    date not null default current_date,
  end_date      date,
  next_run_date date not null default current_date,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists recurring_next_run_idx on public.recurring_tasks (is_active, next_run_date);

alter table public.recurring_tasks enable row level security;

drop policy if exists recurring_select on public.recurring_tasks;
create policy recurring_select on public.recurring_tasks for select using (
  assigned_to = auth.uid()
  or assigned_by = auth.uid()
  or public.is_director_or_admin()
  or public.is_self_or_downline(assigned_to)
);

drop policy if exists recurring_write on public.recurring_tasks;
create policy recurring_write on public.recurring_tasks for all
  using (public.can_assign_to(assigned_to))
  with check (public.can_assign_to(assigned_to));
