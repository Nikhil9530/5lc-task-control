-- ============================================================================
-- 5LC TASK CONTROL - MONITOR NOTIFICATION VERIFICATION (READ ONLY)
--
-- Run this AFTER applying migration 0022 and AFTER exercising the app.
-- It does not change anything; it only reports whether the invariants hold.
--
-- Paste into Supabase Dashboard -> SQL Editor -> Run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Triggers actually installed?
--    Every row here must be present. A missing trigger = a dead event.
-- ----------------------------------------------------------------------------
select
  tgname                                   as trigger_name,
  tgrelid::regclass::text                  as on_table,
  tgenabled                                as enabled
from pg_trigger
where tgname in (
  'comments_notify_monitor',
  'tasks_notify_monitor',
  'tasks_notify_monitor_insert',
  'extensions_notify_monitor'
)
order by on_table, trigger_name;

-- ----------------------------------------------------------------------------
-- 2) Functions installed?
-- ----------------------------------------------------------------------------
select
  p.proname                                as function_name,
  p.provolatile                            as volatility,   -- 'i' = immutable
  p.prosecdef                              as security_definer,
  p.proconfig                              as settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'notify_task_monitor',
    'task_monitoring_snapshot'
  )
order by p.proname;

-- Expected: task_monitoring_snapshot is prostable ('s') + prosecdef true.
-- If either differs, the read-only guarantee is not in place.

-- ----------------------------------------------------------------------------
-- 3) No monitor fan-out: every monitor notification must go to a
--    director/super_admin who is a PARTY to that task.
--    Any row returned here is a constraint violation.
-- ----------------------------------------------------------------------------
select n.id, n.user_id, p.role, n.type, n.task_id, t.assigned_by, t.created_by
from public.notifications n
join public.profiles p on p.id = n.user_id
left join public.tasks t on t.id = n.task_id
where n.dedupe_key like 'mon:%'
  and (
    p.role not in ('director', 'super_admin')
    or coalesce(t.assigned_by, t.created_by) is distinct from n.user_id
  );

-- Expected: ZERO rows.

-- ----------------------------------------------------------------------------
-- 4) No self-notification: the actor must not be the recipient.
--    Any row returned here is a constraint violation.
-- ----------------------------------------------------------------------------
select
  h.task_id,
  h.action,
  h.user_id                            as actor,
  h.created_at,
  n.user_id                            as notified
from public.task_history h
join public.notifications n
  on n.dedupe_key = 'mon:status:' || h.task_id::text || ':' || h.created_at::text
where h.user_id = n.user_id;

-- Expected: ZERO rows.

-- ----------------------------------------------------------------------------
-- 5) No duplicate monitor rows for the same event.
--    Any row returned here is a constraint violation.
-- ----------------------------------------------------------------------------
select dedupe_key, count(*) as rows_created
from public.notifications
where dedupe_key like 'mon:%'
group by dedupe_key
having count(*) > 1;

-- Expected: ZERO rows.

-- ----------------------------------------------------------------------------
-- 6) What the monitor actually received, newest first - the working report.
--    task_status / task_commented / task_reassigned / extension_* all count.
-- ----------------------------------------------------------------------------
select
  n.created_at,
  p.full_name                            as recipient,
  p.role,
  coalesce(t.title, '-')                 as task,
  n.type,
  n.title                                as notification,
  n.message
from public.notifications n
join public.profiles p on p.id = n.user_id
left join public.tasks t on t.id = n.task_id
where n.dedupe_key like 'mon:%'
order by n.created_at desc
limit 50;

-- ----------------------------------------------------------------------------
-- 7) Coverage sanity: the four lifecycle statuses plus comments, per task.
--    A task assigned by a director should show each event that actually
--    happened. Nothing to assert automatically - this is the human checklist.
-- ----------------------------------------------------------------------------
select
  t.id,
  t.title,
  t.status,
  pa.full_name                           as assigned_by,
  (select count(*) from public.notifications n
    where n.task_id = t.id and n.dedupe_key like 'mon:status:%')        as status_pings,
  (select count(*) from public.notifications n
    where n.task_id = t.id and n.dedupe_key like 'mon:comment:%')       as comment_pings,
  (select count(*) from public.notifications n
    where n.task_id = t.id and n.dedupe_key like 'mon:due:%')          as due_date_pings,
  (select count(*) from public.notifications n
    where n.task_id = t.id and n.dedupe_key like 'mon:reassigned:%')   as delegate_pings
from public.tasks t
left join public.profiles pa on pa.id = coalesce(t.assigned_by, t.created_by)
where pa.role in ('director', 'super_admin')
order by t.created_at desc
limit 25;
