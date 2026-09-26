-- ============================================================================
-- 5LC TASK CONTROL - 0022 DIRECTOR MONITORING NOTIFICATIONS
--
-- HOW TO RUN THIS
-- ---------------
-- Run in the Supabase SQL Editor ONE BLOCK AT A TIME, blocks 1 to 6, in order.
-- Each block is self-contained and idempotent ("create or replace" /
-- "if exists"), so a block can safely be re-run.
--
-- Do NOT paste the whole file at once. The dashboard editor splits pasted text
-- on semicolons, and plpgsql bodies are full of them, so a body gets cut in
-- half and you get a bogus error like:
--     ERROR: 42601: syntax error at or near "perform"
-- That error is an artifact of the paste, not a fault in this SQL.
--
-- WHAT IT DOES
-- ------------
-- A Director or Super Admin who assigns a task is responsible for following it
-- to completion, but was only told at assignment and again at completion. A
-- comment produced NO notification at all (task_comments had no trigger), and
-- a status change to not_started / in_progress / waiting wrote history but no
-- notification.
--
-- THE RULE
-- --------
-- A task's MONITOR is the director/super_admin who assigned or created it
-- (coalesce(assigned_by, created_by)). That one person is notified across the
-- task's whole lifecycle: assigned | commented | status changed (all four) |
-- delegated/reassigned | extension requested/decided | due date changed.
--
-- THREE HARD CONSTRAINTS, all enforced in ONE place (block 1's helper):
--   1. NO COMPANY-WIDE FAN-OUT. No monitor -> this file is a no-op for that
--      task and today's behaviour applies unchanged.
--   2. NO SELF-NOTIFICATION. The actor is never told about their own action.
--   3. EXACTLY ONE ROW PER PERSON PER EVENT, via dedupe_key. 0010 already
--      notifies assigned_by on completion; if the monitor IS assigned_by that
--      must not become two notifications.
--
-- 0010 and 0014 are deliberately LEFT INTACT - this file only adds a parallel
-- monitor channel, so nothing that already works can regress.
-- ============================================================================


-- ############################################################################
-- BLOCK 1 - the helper every monitor notification funnels through
-- ############################################################################
create or replace function public.notify_task_monitor(p_task_id uuid, p_event text, p_type text, p_title text, p_verb text, p_actor uuid default null, p_dedupe text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_monitor uuid;
  v_actor text;
begin
  select * into v_task from public.tasks where id = p_task_id;
  if not found then
    return;
  end if;

  -- CONSTRAINT 1: the monitor must be a director/super_admin who is a PARTY to
  -- THIS task. coalesce means one person, so a single event can never fan out
  -- to the same human twice.
  select p.id into v_monitor from public.profiles p
    where p.id = coalesce(v_task.assigned_by, v_task.created_by)
      and p.role in ('director', 'super_admin');

  if v_monitor is null then
    return;
  end if;

  -- CONSTRAINT 2: never notify the actor about their own action.
  if p_actor is not null and v_monitor = p_actor then
    return;
  end if;

  select full_name into v_actor from public.profiles where id = p_actor;

  -- CONSTRAINT 3: one row per person per event occurrence. Callers pass a key
  -- unique to the occurrence (the row id, or the task's new updated_at), so a
  -- task may legitimately move in_progress -> waiting -> in_progress and still
  -- notify each time.
  insert into public.notifications (user_id, type, title, message, task_id, dedupe_key)
  values (
    v_monitor,
    p_type,
    p_title,
    coalesce(v_actor, 'Someone') || ' ' || p_verb || ' "' || v_task.title || '" now ' || replace(v_task.status, '_', ' '),
    p_task_id,
    coalesce(p_dedupe, 'mon:' || p_event || ':' || p_task_id::text)

-- ############################################################################
-- BLOCK 2 - a new comment reaches the monitor
--
-- Before this, task_comments had NO trigger at all, so a comment was invisible
-- to everyone except someone who happened to open the task.
-- ############################################################################
create or replace function public.tg_comments_notify_monitor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify_task_monitor(new.task_id, 'comment', 'task_commented', 'Task Update', 'commented on', new.user_id, 'mon:comment:' || new.id::text);
  return new;
end;
$$;

drop trigger if exists comments_notify_monitor on public.task_comments;
create trigger comments_notify_monitor
  after insert on public.task_comments
  for each row execute function public.tg_comments_notify_monitor();


-- ############################################################################
-- BLOCK 3 - the task lifecycle: status, delegation/reassignment, due date
--
-- Runs ALONGSIDE 0010's triggers (it does not replace them), so history and
-- the existing assignee/assigner notifications are untouched.
--
-- updated_at is stamped by 0010's BEFORE trigger, so it already holds the new
-- value here and is unique per update transaction. That is what lets a task
-- cycle in_progress -> waiting -> in_progress and notify each time, while a
-- duplicated statement still collapses to a single row.
-- ############################################################################
create or replace function public.tg_tasks_notify_monitor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    perform public.notify_task_monitor(new.id, 'status', 'task_status', 'Task Update', 'changed the status of', auth.uid(), 'mon:status:' || new.id::text || ':' || new.updated_at::text);
  end if;

  if new.assigned_to is distinct from old.assigned_to then
    perform public.notify_task_monitor(new.id, 'reassigned', 'task_reassigned', 'Task Delegated', 'reassigned', auth.uid(), 'mon:reassigned:' || new.id::text || ':' || new.updated_at::text);
  end if;

  if new.due_date is distinct from old.due_date then
    perform public.notify_task_monitor(new.id, 'due', 'task_due_changed', 'Task Update', 'changed the due date of', auth.uid(), 'mon:due:' || new.id::text || ':' || new.updated_at::text);
  end if;

  return null;
end;
$$;

drop trigger if exists tasks_notify_monitor on public.tasks;
create trigger tasks_notify_monitor
  after update on public.tasks
  for each row execute function public.tg_tasks_notify_monitor();


-- ############################################################################
-- BLOCK 4 - on assignment
--
-- 0010 already tells the ASSIGNEE. This covers the monitor, and the
-- self-notification guard means a Director who assigns the task is skipped, so
-- it is normally a no-op. It exists for a task created on someone else's
-- behalf.
-- ############################################################################
create or replace function public.tg_tasks_notify_monitor_insert()
returns trigger
language plpgsql
security definer

-- ############################################################################
-- BLOCK 5 - extensions reach BOTH the upline (0014, untouched) and the monitor
--
-- 0014 notifies the requester's manager/director. A director who assigned the
-- task also needs to know their own deadline slipped.
-- ############################################################################
create or replace function public.tg_extensions_notify_monitor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event text;
  v_title text;
  v_verb text;
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    v_event := 'extension_requested';
    v_title := 'Extension Requested';
    v_verb := 'requested more time on';
    v_actor := new.requested_by;
  elsif new.status is distinct from old.status and new.status <> 'pending' then
    if new.status = 'approved' then
      v_event := 'extension_approved';
      v_title := 'Extension Approved';
      v_verb := 'approved more time on';
    else
      v_event := 'extension_rejected';
      v_title := 'Extension Rejected';
      v_verb := 'rejected a request for more time on';
    end if;
    v_actor := coalesce(new.reviewed_by, auth.uid());
  else
    return new;
  end if;

  perform public.notify_task_monitor(new.task_id, v_event, v_event, v_title, v_verb, v_actor, 'mon:' || v_event || ':' || new.id::text);
  return new;
end;
$$;

drop trigger if exists extensions_notify_monitor on public.task_extensions;
create trigger extensions_notify_monitor
  after insert or update on public.task_extensions
  for each row execute function public.tg_extensions_notify_monitor();


-- ############################################################################
-- BLOCK 6 - READ-ONLY MONITORING VIEW (server-enforced)
--
-- The Director/Super Admin monitoring screen must be read-only, and that has to
-- be true SERVER-SIDE, not merely hidden in the UI. This is the authorised read
-- path for that screen:
--
--   * it is STABLE, so it cannot write, by construction
--   * it is SECURITY DEFINER, so the visibility test is evaluated by the
--     database rather than trusted from the client
--   * it returns one snapshot (task + full history + comments) or NOTHING when
--     the caller has no permitted relationship to that task
--
-- HONEST LIMIT: this guarantees the monitoring SCREEN has no write path. It
-- cannot revoke the write that tasks_update already grants a director, because
-- the app legitimately needs that elsewhere. Closing that last gap means moving
-- every task write behind its own RPC - a separate, riskier change, deliberately
-- not bundled here.
-- ############################################################################
create or replace function public.task_monitoring_snapshot(p_task_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with permitted as (
    select t.*
    from public.tasks t
    where t.id = p_task_id
      and (
        t.assigned_to = auth.uid()
        or t.assigned_by = auth.uid()
        or t.created_by = auth.uid()
        or public.is_director_or_admin()
        or public.is_self_or_downline(t.assigned_to)
      )
  )
  select jsonb_build_object(
    'task', (select to_jsonb(p) from permitted p),
    'history', coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc) from public.task_history h join permitted p on p.id = h.task_id), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at asc) from public.task_comments c join permitted p on p.id = c.task_id), '[]'::jsonb)
  )
  from permitted
  limit 1;
$$;

revoke all on function public.task_monitoring_snapshot(uuid) from public;
grant execute on function public.task_monitoring_snapshot(uuid) to authenticated;

comment on function public.task_monitoring_snapshot(uuid) is
  'Authorised read-only snapshot (task + history + comments) for Director/Super Admin monitoring. Returns NULL when the caller may not see the task.';

set search_path = public
as $$
begin
  perform public.notify_task_monitor(new.id, 'assigned', 'task_assigned', 'Task Assigned', 'assigned', coalesce(new.assigned_by, new.created_by), 'mon:assigned:' || new.id::text);
  return new;
end;
$$;

drop trigger if exists tasks_notify_monitor_insert on public.tasks;
create trigger tasks_notify_monitor_insert
  after insert on public.tasks
  for each row execute function public.tg_tasks_notify_monitor_insert();

  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

revoke all on function public.notify_task_monitor(uuid, text, text, text, text, uuid, text) from public;
grant execute on function public.notify_task_monitor(uuid, text, text, text, text, uuid, text) to authenticated;
