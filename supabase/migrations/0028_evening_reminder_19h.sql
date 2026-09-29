-- ============================================================================
-- 5LC TASK CONTROL - 0028 MOVE THE EVENING REMINDER SLOT TO 19:00 IST
--
-- WHY THIS EXISTS
-- ---------------
-- 0025 already sends due_today and overdue TWICE a day, and that part works:
-- each task gets one AM and one PM row, told apart by the `:am` / `:pm` suffix
-- on dedupe_key. The two-per-task behaviour is correct.
--
-- What was wrong is the HOUR. 0025 scheduled the second slot at:
--
--     '30 10 * * *'   ->  10:30 UTC  ->  16:00 IST
--
-- 16:00 IST is mid-afternoon, not evening. Both pings therefore landed inside
-- the same working afternoon, and the second one read as "why am I being told
-- this again already" rather than as an end-of-day prompt.
--
-- 19:00 IST is 13:30 UTC:
--
--     '30 13 * * *'   ->  13:30 UTC  ->  19:00 IST
--
-- WHAT CHANGES
--   The cron schedule of `lc-afternoon-reminders`, and nothing else.
--
-- WHAT DOES NOT CHANGE
--   run_reminder_checks() and its logic, every dedupe key, every notification
--   type and recipient, the 09:00 IST morning job, pending_reminder and
--   escalation (both once a day by design), and all RLS policies and triggers.
--   No notification row is written, altered or deleted by this migration.
--
-- WHY A NEW FILE AND NOT AN EDIT TO 0025
--   0025 is APPLIED HISTORY. Editing it would make the repo claim a schedule
--   production never had, and 0026 already records three incidents of this
--   repo drifting away from the live database. So 0025 stays an honest record
--   of what was actually run, and this file corrects the clock.
--
-- HOW TO RUN
--   Supabase -> SQL Editor. BLOCK 1, then BLOCK 2 to confirm. SQL only: no app
--   change, no OTA, nothing to rebuild.
-- ============================================================================


-- ============================================================================
-- BLOCK 1  -  RESCHEDULE THE EVENING SLOT TO 19:00 IST
--
-- cron.schedule takes UTC. Asia/Kolkata is UTC+5:30 all year with no DST, so
-- 19:00 IST = 13:30 UTC every day of the year, with no seasonal drift.
--
-- The unschedule-then-schedule pair is copied from 0025 deliberately. Calling
-- cron.schedule again for a name that already exists ADDS A SECOND JOB rather
-- than replacing it, which would fire the evening reminder twice a day from
-- the day this migration is applied. The `where exists` guard also keeps this
-- a clean no-op on a project where the job was never created.
-- ============================================================================

do $$
begin
  create extension if not exists pg_cron;

  perform cron.unschedule('lc-afternoon-reminders')
    where exists (
      select 1 from cron.job where jobname = 'lc-afternoon-reminders'
    );

  perform cron.schedule('lc-afternoon-reminders', '30 13 * * *',
    $job$ select public.run_afternoon_checks(); $job$);

  raise notice
    'Evening reminder rescheduled: 13:30 UTC = 19:00 IST (was 16:00 IST).';
exception when others then
  raise notice
    'pg_cron unavailable: %. Reschedule public.run_afternoon_checks() '
    'externally at 19:00 IST = 13:30 UTC.', sqlerrm;
end;
$$;


-- ============================================================================
-- BLOCK 2  -  VERIFY
--
-- 2a) The schedule. `lc-afternoon-reminders` must read '30 13 * * *'.
--
--     Every other row must be UNCHANGED from the 0025 block 4b table:
--
--       lc-daily-task-checks       30 3  * * *   09:00 IST  (0025/0009)
--       lc-prune-notifications     15 2  * * *   07:45 IST  (0021)
--       lc-recurring-tasks         35 18 * * *   00:05 IST  (0009)
--       lc-dispatch-notifications  */5 * * * *   delivery   (DEPLOYMENT.md)
--
--     No row with 'dispatch' in the name means notification ROWS are being
--     created but no push or email ever leaves the server, while the in-app
--     inbox still looks fine because it reads rows directly.
-- ============================================================================

select
  jobname,
  schedule,
  active,
  case
    when jobname = 'lc-afternoon-reminders'
      then '19:00 IST - moved by 0028'
    when jobname = 'lc-daily-task-checks'
      then '09:00 IST - unchanged'
    else ''
  end as slot_note
from cron.job
where jobname like 'lc-%'
   or jobname like '%dispatch%'
order by jobname;


-- ============================================================================
-- 2b) EXACTLY ONE evening job, and it must be on the new hour.
--
--     Expect evening_jobs 1, on_19_ist 1, still_on_old_hour 0.
--
--     evening_jobs = 2   -> the unschedule half of block 1 did not run, so the
--                           evening reminder will now fire twice a day. Undo
--                           by unscheduling every row but one.
--     still_on_old_hour 1 -> block 1 did not apply at all; the job is still
--                           running at 16:00 IST.
-- ============================================================================

select
  count(*) as evening_jobs,
  count(*) filter (where schedule = '30 13 * * *') as on_19_ist,
  count(*) filter (where schedule <> '30 13 * * *') as still_on_old_hour
from cron.job
where jobname = 'lc-afternoon-reminders';


-- ============================================================================
-- 2c) CONFIRM THE TWICE-A-DAY BEHAVIOUR SURVIVED THE MOVE.
--
--     Run this TOMORROW, after both jobs have fired. Expect due_today and
--     overdue to read 'slot-suffixed' with TWO rows each.
--
--     If either reads 'date only', or shows one row instead of two, the
--     second run is being swallowed by the dedupe index and only the morning
--     reminder is reaching anyone - which would be a real fault, not a
--     reporting quirk, and means the `:am` / `:pm` suffix is missing.
--
--     pending_reminder and escalation reading 'date only' with ONE row is
--     CORRECT. Those are once-a-day by design and are deliberately not part of
--     the two-per-day behaviour, so do not "fix" them.
-- ============================================================================

select
  type,
  case
    when dedupe_key is null then 'no key'
    when dedupe_key ~ ':(am|pm)$' then 'slot-suffixed (twice a day)'
    else 'date only (once a day)'
  end as key_shape,
  count(*) as row_count,
  min(created_at) as first_sent,
  max(created_at) as last_sent
from public.notifications
where type in ('due_today', 'overdue', 'pending_reminder', 'escalation')
  and created_at >= current_date
group by 1, 2
order by 1, 2;


-- ============================================================================
-- END OF 0028
--
-- AFTER APPLYING
--   The evening reminder takes effect from the next 19:00 IST. Nothing is
--   sent retroactively and no existing row is altered.
--
-- ONE THING TO EXPECT ON DAY ONE, AND WHY
--   Tonight's evening reminder may NOT arrive, and that is correct rather than
--   broken. The dedupe key is 'overdue:<id>:<date>:pm'. If a 'pm' row for
--   today already exists - written by the old 16:00 run - then
--   `on conflict (dedupe_key) do nothing` suppresses the new one. Rescheduling
--   a job cannot reach back and delete a row that already exists, so the
--   evening ping is swallowed for the remainder of TODAY only. Both slots fire
--   normally from tomorrow onward.
--
--   To get tonight's evening reminder after all, delete today's pm rows
--   BEFORE 19:00 IST:
--
--     delete from public.notifications
--     where type in ('due_today', 'overdue')
--       and dedupe_key ~ ':pm$'
--       and created_at >= current_date;
--
--   That step is optional. Skip it and you simply lose one evening reminder
--   for today; the cadence is correct from tomorrow either way.
-- ============================================================================
