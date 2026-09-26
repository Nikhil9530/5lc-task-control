-- 0019_dashboard_counts.sql
--
-- WHY THIS EXISTS
-- ---------------
-- The dashboard KPI numbers visibly "popped in" about two seconds after the
-- screen opened. The cause was in dashboard.tsx:
--
--   1. supabase.auth.getUser()  -> a NETWORK round-trip to the auth server
--   2. profiles  select          -> round-trip (sequential)
--   3. notifications count       -> round-trip (sequential)
--   4. SEVEN separate `count: 'exact'` queries against public.tasks
--
-- That is four sequential round-trips before any number could be painted, and
-- with RLS enabled each `count: 'exact'` is expensive because Postgres must
-- evaluate the policy for every candidate row.
--
-- This function collapses all seven counts into ONE round-trip. The client
-- calls it once and paints the whole KPI strip in a single setState.
--
-- `security invoker` is deliberate: the function does NOT bypass RLS, so the
-- numbers stay automatically role-scoped exactly as before
-- (employee -> own tasks, manager -> downline, director -> company-wide).

create or replace function public.dashboard_counts(p_today date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'active',          count(*) filter (where status <> 'completed'),
    'due_today',       count(*) filter (where due_date = p_today and status <> 'completed'),
    'overdue',         count(*) filter (where due_date < p_today and status <> 'completed'),
    'completed_today', count(*) filter (where status = 'completed'
                                         and completed_at >= (p_today::timestamp at time zone 'UTC')),
    'not_started',     count(*) filter (where status = 'not_started'),
    'in_progress',     count(*) filter (where status = 'in_progress'),
    'waiting',         count(*) filter (where status = 'waiting')
  )
  from public.tasks;
$$;

comment on function public.dashboard_counts(date) is
  'Single-round-trip KPI counts for the dashboard. Respects RLS (security invoker).';

-- Only signed-in users need this, and only through PostgREST.
revoke all on function public.dashboard_counts(date) from public;
grant execute on function public.dashboard_counts(date) to authenticated;
