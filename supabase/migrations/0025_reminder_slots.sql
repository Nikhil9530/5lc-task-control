-- ============================================================================
-- 5LC TASK CONTROL - 0025 REMINDER SLOTS + MONITOR PINGS
--
-- WHY THIS EXISTS
-- ---------------
-- Section K of the requirements asked for reminder cadence that
-- 0008 never provided:
--
--   20. Daily incomplete reminder at 09:00 IST ............. already existed
--   21. Due Today -> TWICE a day ........................... was ONCE
--   22. Overdue   -> TWICE a day ........................... was ONCE
--   23. Director/Super Admin monitor ping on due/overdue ... MISSING
--   24. Completed stops all reminders ...................... already correct
--   25. No duplicates, no self-notification ................. required
--
-- TIMING (Asia/Kolkata, UTC+5:30)
--   Slot AM  09:00 IST = 03:30 UTC -> the existing lc-daily-task-checks
--   Slot PM  16:00 IST = 10:30 UTC -> NEW lc-afternoon-reminders
--
-- THE TRAP THIS FILE AVOIDS
-- -------------------------
-- Every reminder key previously ended with the DATE ONLY, e.g.
--     'due_today:' || id || ':' || v_today
-- combined with `on conflict (dedupe_key) do nothing`. So simply adding a
-- second cron run would be swallowed by that conflict clause: the job would
-- succeed, look healthy, and send NOTHING. Every key that fires twice a day
-- therefore gains a slot suffix (:am / :pm).
--
-- WHY THE DEDUPE LOOKS THIS WAY
-- -----------------------------
-- Overdue can reach one person by three different routes: they are the
-- assignee, they are in the assignee's escalation chain, or they are the
-- Director/Super Admin monitoring the task. Each route historically used a
-- different key prefix, so one person could receive two or three rows for a
-- single overdue task. Here the escalation insert explicitly skips anyone
-- who is the assignee or the monitor, so there is exactly one row per person
-- per event - requirement 25.
--
-- WHAT IS UNCHANGED
-- -----------------
--   * 09:00 IST behaviour: lc-daily-task-checks still calls
--     run_daily_task_checks(), and that function keeps its zero-argument
--     signature so an existing schedule (or a re-run of 0009) keeps working.
--   * `rejected` and `waiting` still generate reminders - deliberately, per
--     instruction.
--   * The 09:00 slot time itself is untouched.
--   * escalation_targets() still walks the reporting chain for the
--     ESCALATION message. Only the monitor ping is assigner-based.
--
-- HOW TO RUN THIS FILE
-- --------------------
-- Supabase -> SQL Editor. One block at a time, 1 -> 4.
-- ============================================================================


-- ============================================================================
-- BLOCK 1  -  THE CORE ENGINE: run_reminder_checks(p_slot)
--
-- 'am' : daily incomplete reminder + due-today + overdue + escalation
-- 'pm' : due-today + overdue only  (the incomplete reminder is daily-once)
-- ============================================================================

create or replace function public.run_reminder_checks(p_slot text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s           public.system_settings%rowtype;
  v_today     date;
  v_is_am     boolean;
  v_monitor   uuid;
  r           record;
  t           record;
  v_targets   text[];
begin
  if p_slot not in ('am', 'pm') then
    raise exception 'run_reminder_checks: p_slot must be ''am'' or ''pm''.'
      using errcode = 'check_violation';
  end if;

  v_is_am := (p_slot = 'am');

  select * into s from public.system_settings where id = 1;
  v_today := current_date;

  -- -------------------------------------------------------------------------
  -- 1) DAILY INCOMPLETE REMINDER  (requirement 20)
  --    AM only - this is a once-per-day notice, so its key stays date-only.
  --    Open tasks that are NOT due today; anything due today is covered by
  --    the due-today loop below.
  -- -------------------------------------------------------------------------
  if v_is_am then
    for r in
      select id, title, assigned_to
      from public.tasks
      where status <> 'completed'
        and (due_date is null or due_date <> v_today)
    loop
      insert into public.notifications
        (user_id, type, title, message, task_id, dedupe_key)
      values
        (r.assigned_to, 'pending_reminder', 'Pending Task Reminder',
         'Reminder: "' || r.title || '" is still pending.',
         r.id,
         'pending:' || r.id::text || ':' || v_today::text)
      on conflict (dedupe_key) where dedupe_key is not null
      do nothing;
    end loop;
  end if;

  -- -------------------------------------------------------------------------
  -- 2) DUE TODAY  (requirement 21 - TWICE a day, AM and PM)
  --
  --    The :am / :pm suffix is the whole point of this block. Without it the
  --    second run of the day would hit `on conflict do nothing` and vanish.
  -- -------------------------------------------------------------------------
  for r in
    select id, title, assigned_to, assigned_by, created_by
    from public.tasks
    where status <> 'completed'
      and due_date = v_today
  loop
    -- The person doing the work.
    insert into public.notifications
      (user_id, type, title, message, task_id, dedupe_key)
    values
      (r.assigned_to, 'due_today', 'Task Due Today',
       'Your task "' || r.title || '" is due today.',
       r.id,
       'due_today:' || r.id::text || ':' || v_today::text
       || ':' || p_slot)
    on conflict (dedupe_key) where dedupe_key is not null
    do nothing;

    -- The Director / Super Admin monitoring this task (requirement 23).
    -- p_actor = the assignee, so notify_task_monitor suppresses it when the
    -- monitor IS the assignee - that is the no-self-notification rule, and it
    -- is what makes a personal task silent.
    perform public.notify_task_monitor(
      r.id,
      'due_today',
      'due_today',
      'Task Due Today',
      'has a task due today on',
      r.assigned_to,
      'mon:due_today:' || r.id::text || ':' || v_today::text
      || ':' || p_slot
    );
  end loop;

  -- -------------------------------------------------------------------------
  -- 3) OVERDUE  (requirement 22 - TWICE a day) + MONITOR PING (req. 23)
  --
  --    One person must not get two rows for the same overdue task. The
  --    escalation insert below therefore skips anyone who is the assignee or
  --    the monitor; both of those already have their own row.
  -- -------------------------------------------------------------------------
  for r in
    select id, title, assigned_to, assigned_by, created_by,
           due_date, priority,
           (v_today - due_date) as days_overdue
    from public.tasks
    where status <> 'completed'
      and due_date is not null
      and due_date < v_today
  loop
    -- Who monitors this task (the Director / Super Admin who assigned or
    -- created it). NULL when nobody does - an employee-created task.
    select p.id into v_monitor
    from public.profiles p
    where p.id = coalesce(r.assigned_by, r.created_by)
      and p.role in ('director', 'super_admin');

    -- 3a) The person doing the work.
    insert into public.notifications
      (user_id, type, title, message, task_id, dedupe_key)
    values
      (r.assigned_to, 'overdue', 'Task Overdue',
       '"' || r.title || '" is overdue by ' || r.days_overdue
       || ' day(s) and is still incomplete.',
       r.id,
       'overdue:' || r.id::text || ':' || v_today::text
       || ':' || p_slot)
    on conflict (dedupe_key) where dedupe_key is not null
    do nothing;

    -- 3b) The monitoring Director / Super Admin.
    perform public.notify_task_monitor(
      r.id,
      'overdue',
      'overdue',
      'Task Overdue',
      'has an overdue task on',
      r.assigned_to,
      'mon:overdue:' || r.id::text || ':' || v_today::text
      || ':' || p_slot
    );

    -- 3c) ESCALATION - unchanged behaviour: AM only, once per day, keyed by
    --     date alone so it can never fire twice. Skips the assignee and the
    --     monitor so nobody receives this AND 3a/3b for the same task.
    if v_is_am then
      v_targets := array[]::text[];

      if r.priority = 'urgent' then
        if r.days_overdue >= s.urgent_escalate_day_director then
          v_targets := array['manager', 'head', 'director'];
        elsif r.days_overdue >= s.urgent_escalate_day_head then
          v_targets := array['manager', 'head'];
        else
          v_targets := array['manager'];
        end if;
      else
        if r.days_overdue >= s.escalate_day_director then
          v_targets := array['director'];
        elsif r.days_overdue >= s.escalate_day_head then
          v_targets := array['head'];
        elsif r.days_overdue >= s.escalate_day_manager then
          v_targets := array['manager'];
        end if;
      end if;

      if array_length(v_targets, 1) is not null then
        for t in
          select * from public.escalation_targets(r.assigned_to)
        loop
          if t.level = any (v_targets)
             and t.user_id <> r.assigned_to
             and (v_monitor is null or t.user_id <> v_monitor) then
            insert into public.notifications
              (user_id, type, title, message, task_id, dedupe_key)
            values
              (t.user_id, 'escalation', 'Escalation: Overdue Task',
               'Task "' || r.title || '" is overdue by '
               || r.days_overdue
               || ' day(s) and needs attention.',
               r.id,
               'esc:' || t.level || ':' || r.id::text
               || ':' || v_today::text)
            on conflict (dedupe_key) where dedupe_key is not null
            do nothing;
          end if;
        end loop;
      end if;
    end if;
  end loop;
end;
$$;

comment on function public.run_reminder_checks(text) is
  'Reminder engine for one slot (am/pm). am = daily + due-today + overdue + '
  'escalation; pm = due-today + overdue. Keyed per slot so a second run of '
  'the day is not swallowed by the dedupe index.';

revoke all on function public.run_reminder_checks(text)
  from public, anon, authenticated;

-- ============================================================================
-- BLOCK 2  -  run_daily_task_checks() KEEPS ITS SIGNATURE
--
-- The existing schedule lc-daily-task-checks runs
--     select public.run_daily_task_checks();
-- and so does a re-run of 0009. Rather than re-schedule or drop that job,
-- the zero-argument function is re-bodied to delegate to the AM slot. The
-- schedule, the name and the behaviour of the 09:00 IST run all stay as
-- they were.
-- ============================================================================

create or replace function public.run_daily_task_checks()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.run_reminder_checks('am');
end;
$$;

revoke all on function public.run_daily_task_checks()
  from public, anon, authenticated;


-- ============================================================================
-- BLOCK 3  -  run_afternoon_checks()  (the 16:00 IST slot)
--
-- Requirement 21/22 need two reminders. The second one runs here: due-today
-- and overdue only - the daily incomplete reminder stays a once-a-day notice.
-- ============================================================================

create or replace function public.run_afternoon_checks()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.run_reminder_checks('pm');
end;
$$;

revoke all on function public.run_afternoon_checks()
  from public, anon, authenticated;

-- ============================================================================
-- BLOCK 4  -  SCHEDULE THE SECOND SLOT + VERIFY
--
-- 16:00 IST = 10:30 UTC (company timezone Asia/Kolkata, UTC+5:30).
-- Wrapped in the same try/except as 0009 so this file still applies on a
-- project where pg_cron is unavailable.
-- ============================================================================

do $$
begin
  create extension if not exists pg_cron;

  perform cron.unschedule('lc-afternoon-reminders')
    where exists (
      select 1 from cron.job where jobname = 'lc-afternoon-reminders'
    );

  perform cron.schedule('lc-afternoon-reminders', '30 10 * * *',
    $job$ select public.run_afternoon_checks(); $job$);

  raise notice 'Afternoon reminder job scheduled (10:30 UTC = 16:00 IST).';
exception when others then
  raise notice
    'pg_cron not available on this plan/project: %. '
    'Schedule public.run_afternoon_checks() with an '
    'external scheduler instead.',
    sqlerrm;
end;
$$;


-- ============================================================================
-- BLOCK 4b  -  VERIFY THE SCHEDULE
--
-- Expect FIVE rows. Anything missing means that reminder path is dead:
--
--   lc-afternoon-reminders   30 10 * * *   16:00 IST  NEW
--   lc-daily-task-checks     30 3  * * *   09:00 IST  (0009)
--   lc-prune-notifications   15 2  * * *   07:45 IST  (0021)
--   lc-recurring-tasks       35 18 * * *   00:05 IST  (0009)
--   dispatch-notifications   */5 * * * *   every 5min  DEPLOYMENT.md STEP 5
--
-- The last one is NOT created by any migration - it is a manual step. If it
-- is absent, notification ROWS are created but no push or email ever leaves
-- the server, while the in-app inbox still works (it reads rows directly).
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
-- END OF 0025
--
-- WHAT THIS MIGRATION DID NOT DO
--   1. It does not schedule `dispatch-notifications` - that requires your
--      DISPATCH_SECRET, so it stays a manual step (DEPLOYMENT.md STEP 5).
--      Run BLOCK 4b first to see whether you already have it.
--   2. rejected / waiting tasks still produce reminders - unchanged, as
--      instructed.
--   3. escalation_targets() still walks manager_id for the ESCALATION
--      message. The monitor ping is assigner-based; the two coexist without
--      double-sending because 3c skips anyone already notified.
--
-- TO VERIFY AFTER RUNNING
--   See supabase/diagnostics/verify_reminder_slots.sql - read-only.
-- ============================================================================
