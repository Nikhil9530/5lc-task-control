-- ============================================================================
-- 5LC TASK CONTROL - DATA INVENTORY (READ ONLY)
--
-- Safe to run: SELECT only, no data is modified.
-- Paste into Supabase Dashboard -> SQL Editor -> Run.
--
-- NOTE: this must be run in the SQL Editor (which executes as `postgres`).
-- The app's sb_publishable_ key is subject to RLS and will report zeros for
-- rows you are not signed in as, so it is useless for a real census.
-- ============================================================================

-- 1. Row counts per table ---------------------------------------------------
select 'tasks'               as table_name, count(*) as row_count from public.tasks
union all select 'notifications',        count(*)        from public.notifications
union all select 'task_comments',        count(*)        from public.task_comments
union all select 'task_extensions',      count(*)        from public.task_extensions
union all select 'task_history',         count(*)        from public.task_history
union all select 'recurring_tasks',      count(*)        from public.recurring_tasks
union all select '--- kept --- profiles', count(*)        from public.profiles
union all select '--- kept --- device_tokens', count(*)   from public.device_tokens
order by row_count desc, table_name;

-- 2. Tasks by status x priority --------------------------------------------
select status, priority, count(*) as tasks
from public.tasks
group by status, priority
order by tasks desc, status, priority;

-- 3. Tasks by lifecycle dates ----------------------------------------------
select
  count(*)                                             as total,
  count(*) filter (where due_date is null)             as no_due_date,
  count(*) filter (where due_date <  current_date)     as overdue,
  count(*) filter (where due_date =  current_date)     as due_today,
  count(*) filter (where parent_task_id is not null)   as sub_tasks,
  min(created_at)::date                                as oldest,
  max(created_at)::date                                as newest
from public.tasks;

-- 4. Notifications by type and read state ---------------------------------
select type, is_read, count(*) as notifications
from public.notifications
group by type, is_read
order by notifications desc, type;

-- 5. What a wipe would actually remove (cascades included) -----------------
select
  (select count(*) from public.tasks)                                          as tasks,
  (select count(*) from public.task_comments)                                 as comments,
  (select count(*) from public.task_extensions)                               as extensions,
  (select count(*) from public.task_history)                                  as history,
  (select count(*) from public.notifications)                                 as notifications,
  (select count(*) from public.recurring_tasks)                               as recurring_templates,
  (select count(*) from public.tasks)
  + (select count(*) from public.task_comments)
  + (select count(*) from public.task_extensions)
  + (select count(*) from public.task_history)
  + (select count(*) from public.notifications)                               as total_rows_to_delete;
