-- ============================================================================
-- 5LC TASK CONTROL - 0009 RECURRING TASK GENERATION + CRON SCHEDULE
-- ============================================================================

-- Creates a normal task for each due recurrence, then advances next_run_date.
-- Each generated task gets its OWN task id + history (blueprint requirement).
create or replace function public.generate_recurring_tasks()
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  r          record;
  v_new_id   uuid;
  v_next     date;
begin
  for r in
    select * from public.recurring_tasks
    where is_active = true
      and next_run_date <= current_date
      and (end_date is null or next_run_date <= end_date)
  loop
    insert into public.tasks (title, description, created_by, assigned_by,
                              assigned_to, priority, status, start_date, due_date)
    values (r.title, r.description, r.assigned_by, r.assigned_by,
            r.assigned_to, r.priority, 'not_started',
            r.next_run_date, r.next_run_date)
    returning id into v_new_id;

    insert into public.task_history (task_id, user_id, action, details)
    values (v_new_id, r.assigned_by, 'task_created',
            jsonb_build_object('task_title', r.title, 'source', 'recurring'));

    insert into public.notifications (user_id, type, title, message, task_id, dedupe_key)
    values (r.assigned_to, 'task_assigned', 'Recurring Task Created',
            'Recurring task "' || r.title || '" has been created and assigned to you.',
            v_new_id, 'recurring:' || r.id::text || ':' || r.next_run_date::text)
    on conflict (dedupe_key) where dedupe_key is not null do nothing;

    v_next := case r.frequency
                when 'daily'   then r.next_run_date + interval '1 day'
                when 'weekly'  then r.next_run_date + interval '7 days'
                when 'monthly' then r.next_run_date + interval '1 month'
              end;

    update public.recurring_tasks
       set next_run_date = v_next::date,
           is_active = case
             when end_date is not null and v_next::date > end_date then false
             else true end
     where id = r.id;
  end loop;
end;
$$;

revoke all on function public.generate_recurring_tasks() from public;

-- ----------------------------------------------------------------------------
-- SCHEDULE (Supabase pg_cron). Company timezone is Asia/Kolkata (UTC+5:30),
-- pg_cron runs in UTC -> 09:00 IST == 03:30 UTC.
-- Wrapped so this file still applies if pg_cron is not enabled on the project.
-- ----------------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron;

  perform cron.unschedule('lc-daily-task-checks')
    where exists (select 1 from cron.job where jobname = 'lc-daily-task-checks');
  perform cron.unschedule('lc-recurring-tasks')
    where exists (select 1 from cron.job where jobname = 'lc-recurring-tasks');

  perform cron.schedule('lc-daily-task-checks', '30 3 * * *',
    $job$ select public.run_daily_task_checks(); $job$);

  -- Recurring task generation shortly after midnight IST (18:35 UTC prev day).
  perform cron.schedule('lc-recurring-tasks', '35 18 * * *',
    $job$ select public.generate_recurring_tasks(); $job$);

  raise notice 'Cron jobs scheduled.';
exception when others then
  raise notice 'pg_cron not available on this plan/project: %. Schedule these SQL calls with an external scheduler instead.', sqlerrm;
end;
$$;
