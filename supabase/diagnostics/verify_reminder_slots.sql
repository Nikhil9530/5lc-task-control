-- ============================================================================
-- 5LC TASK CONTROL - VERIFY 0025 REMINDER SLOTS (READ-ONLY)
--
-- Nothing here writes data. Run A, B, C, D in order.
-- ============================================================================


-- ============================================================================
-- BLOCK A  -  DO THE THREE FUNCTIONS EXIST?
--
-- Expect 3 rows. Note run_reminder_checks is the core and takes an argument;
-- the other two are the zero-argument entry points cron calls.
-- ============================================================================

select
  p.oid::regprocedure::text as signature,
  case p.provolatile
    when 'i' then 'immutable'
    when 's' then 'stable'
    when 'v' then 'volatile'
  end as volatility,
  p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'run_reminder_checks',
    'run_daily_task_checks',
    'run_afternoon_checks'
  )
order by p.proname;


-- ============================================================================
-- BLOCK B  -  ARE THEY LOCKED AWAY FROM THE APP?
--
-- These are cron-only routines: a public reminder engine would let any
-- signed-in user trigger notifications for everyone. Expect anon_can_execute
-- and auth_can_execute to be FALSE on all three.
--
-- This check matters because Supabase grants EXECUTE to `authenticated` by
-- default on new functions in the public schema (alter default privileges),
-- which is exactly how the earlier test harness ended up exposed.
-- ============================================================================

select
  p.proname,
  p.oid::regprocedure::text as signature,
  has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as auth_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'run_reminder_checks',
    'run_daily_task_checks',
    'run_afternoon_checks'
  )
order by p.proname;


-- ============================================================================
-- BLOCK C  -  THE SCHEDULE
--
-- Expect 5 rows. See the table in 0025 BLOCK 4b for the expected output.
-- A missing `dispatch-notifications` row means notification ROWS are created
-- but no push/email is ever delivered - while the in-app inbox still works.
-- ============================================================================

select
  jobname,
  schedule,
  active
from cron.job
where jobname like 'lc-%'
   or jobname = 'dispatch-notifications'
order by jobname;


-- ============================================================================
-- BLOCK D  -  WHAT THE NEXT RUN WILL TARGET  (read-only counts)
--
-- Sanity check that the three loops are pointed at the right rows. All three
-- must exclude completed tasks - that is requirement 24.
-- ============================================================================

select
  (select count(*) from public.tasks
    where status <> 'completed'
      and (due_date is null or due_date <> current_date)
  ) as daily_incomplete_am_only,
  (select count(*) from public.tasks
    where status <> 'completed'
      and due_date = current_date
  ) as due_today_both_slots,
  (select count(*) from public.tasks
    where status <> 'completed'
      and due_date is not null
      and due_date < current_date
  ) as overdue_both_slots,
  (select count(*) from public.tasks
    where status = 'completed'
      and due_date < current_date
  ) as overdue_but_completed_must_be_zero;


-- ============================================================================
-- BLOCK E  -  DID THE SLOT SUFFIX ACTUALLY TAKE?
--
-- Run this AFTER at least one of the two jobs has executed. Requirements 21
-- and 22 are satisfied only when due_today and overdue show the
-- "slot-suffixed" row; if they show "date only", the second run of the day
-- will be swallowed by the dedupe index and no afternoon reminder can be
-- sent.
--
-- pending_reminder and escalation are expected to stay "date only" - those
-- are deliberately once-a-day.
-- ============================================================================

select
  type,
  case
    when dedupe_key is null then 'no key'
    when dedupe_key ~ ':(am|pm)$'
      then 'slot-suffixed (fires twice a day)'
    else 'date only (fires once a day)'
  end as key_shape,
  count(*) as row_count
from public.notifications
where type in ('due_today', 'overdue', 'pending_reminder', 'escalation')
group by 1, 2
order by 1, 2;
