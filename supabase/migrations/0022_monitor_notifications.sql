-- ============================================================================
-- 5LC TASK CONTROL - 0022 DIRECTOR MONITORING NOTIFICATIONS + READ-ONLY VIEW
--
-- WHY THIS EXISTS
-- ---------------
-- A Director or Super Admin who assigns a task is responsible for following it
-- to completion, but they were only told at the moment of assignment and again
-- at completion. Nothing in between reached them: a comment produced NO
-- notification at all (task_comments had no trigger), and a status change to
-- not_started / in_progress / waiting wrote task_history but no notification.
--
-- THE RULE
-- --------
-- A task's MONITOR is the director/super_admin who assigned or created it
-- (coalesce(assigned_by, created_by)). That one person is notified about the
-- task's whole lifecycle:
--
--   assigned | commented | status changed (all 4) | delegated/reassigned
--   | extension requested/decided | due date changed
--
-- THREE HARD CONSTRAINTS
-- ----------------------
-- 1. NO COMPANY-WIDE FAN-OUT. A Director is never notified about a task they
--    did not assign. If a task has no director/admin party, this whole file is
--    a no-op for it and today's behaviour applies unchanged.
-- 2. NO SELF-NOTIFICATION. The actor is never notified about their own action,
--    so a Director who assigns a task does not get a "task assigned" ping.
-- 3. EXACTLY ONE ROW PER PERSON PER EVENT. 0010 already notifies assigned_by
--    on completion; if the monitor IS assigned_by that must not become two
--    notifications. Recipients are therefore de-duplicated by a unique
--    dedupe_key rather than by hoping the triggers disagree.
--
-- 0010 and 0014 are deliberately LEFT INTACT - this file only adds a parallel
-- monitor channel, so nothing that already works can regress.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper: notify the monitor of one task, if that task has one.
--
-- Every monitor notification in this migration funnels through here, so the
-- three constraints above are enforced in exactly ONE place instead of being
-- re-implemented (and eventually forgotten) per trigger.
-- ----------------------------------------------------------------------------
create or replace function public.notify_task_monitor(
  p_task_id  uuid,
  p_event    text,
  p_type     text,
  p_title    text,
  p_verb     text,
  p_actor    uuid default null,
  p_dedupe   text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task     public.tasks%rowtype;
  v_monitor  uuid;
  v_actor    text;
begin
  select * into v_task from public.tasks where id = p_task_id;

  if not found then
    return;                                   -- task vanished; nothing to say
  end if;

  -- CONSTRAINT 1: the monitor must be a director/super_admin who is a party to
  -- THIS task. coalesce means one person, so a completion can never fan out to
  -- the same human twice.
  select p.id into v_monitor
  from public.profiles p
  where p.id = coalesce(v_task.assigned_by, v_task.created_by)
    and p.role in ('director', 'super_admin');

  if v_monitor is null then
    return;                                   -- no director owns this task
  end if;

  -- CONSTRAINT 2: never notify the actor about their own action.
  if p_actor is not null and v_monitor = p_actor then
    return;
  end if;

  select full_name into v_actor
  from public.profiles where id = p_actor;

  insert into public.notifications
    (user_id, type, title, message, task_id, dedupe_key)
  values (
    v_monitor,
    p_type,
    p_title,
    coalesce(v_actor, 'Someone') || ' ' || p_verb || ' "' ||
      v_task.title || '" to ' || replace(v_task.status, '_', ' '),
    p_task_id,
    -- CONSTRAINT 3: one row per person per event occurrence. Callers pass a
    -- key that is unique to the occurrence (row id, or the task's new
    -- updated_at), so a task can legitimately move in_progress -> waiting ->
    -- in_progress and still produce a notification each time.

-- ----------------------------------------------------------------------------
-- TRIGGER 1: a new comment reaches the monitor.
--
-- Before this, task_comments had NO trigger at all, so a comment was invisible
-- to everyone except someone who happened to open the task.
-- ----------------------------------------------------------------------------
create or replace function public.tg_comments_notify_monitor()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.notify_task_monitor(
    new.task_id,
    'comment',
    'task_commented',
    'Task Update',
    'commented on',
    new.user_id,
    'mon:comment:' || new.id::text      -- one ping per comment, ever
  );

  return new;
end;
$$;

drop trigger if exists comments_notify_monitor on public.task_comments;
create trigger comments_notify_monitor
  after insert on public.task_comments
  for each row execute function public.tg_comments_notify_monitor();

-- ----------------------------------------------------------------------------
-- TRIGGER 2: the task lifecycle - status, delegation/reassignment, due date.
--
-- Runs ALONGSIDE 0010's triggers (it does not replace them) so history and the
-- existing assignee/assigner notifications are untouched.
--
-- updated_at is stamped by 0010's BEFORE trigger, so it already holds the new
-- value here and is unique per update transaction - which is what lets a task
-- legitimately cycle in_progress -> waiting -> in_progress and notify each
-- time, while a duplicated statement still collapses to a single row.
-- ----------------------------------------------------------------------------
create or replace function public.tg_tasks_notify_monitor()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    perform public.notify_task_monitor(
      new.id, 'status', 'task_status', 'Task Update', 'changed the status of',
      auth.uid(),
      'mon:status:' || new.id::text || ':' || new.updated_at::text
    );
  end if;

  if new.assigned_to is distinct from old.assigned_to then
    perform public.notify_task_monitor(
      new.id, 'reassigned', 'task_reassigned', 'Task Delegated', 'reassigned',
      auth.uid(),
      'mon:reassigned:' || new.id::text || ':' || new.updated_at::text
    );
  end if;

  if new.due_date is distinct from old.due_date then
    perform public.notify_task_monitor(
      new.id, 'due', 'task_due_changed', 'Task Update', 'changed the due date of',
      auth.uid(),
      'mon:due:' || new.id::text || ':' || new.updated_at::text
    );
  end if;

  return null;                               -- AFTER trigger
end;
$$;

drop trigger if exists tasks_notify_monitor on public.tasks;
create trigger tasks_notify_monitor
  after update on public.tasks
  for each row execute function public.tg_tasks_notify_monitor();

-- ----------------------------------------------------------------------------
-- TRIGGER 3: on assignment.
--
-- 0010 already tells the ASSIGNEE. This covers the monitor, and the
-- self-notification guard means a Director who assigns the task is skipped -
-- so it is normally a no-op, and exists for a task created on someone else's
-- behalf.
-- ----------------------------------------------------------------------------
create or replace function public.tg_tasks_notify_monitor_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.notify_task_monitor(
    new.id, 'assigned', 'task_assigned', 'Task Assigned', 'assigned',
    coalesce(new.assigned_by, new.created_by),

-- ----------------------------------------------------------------------------
-- TRIGGER 4: extensions reach BOTH the upline (0014, untouched) and the
-- monitor. 0014 notifies the requester's manager/director; a director who
-- assigned the task needs to know their own deadline slipped too.
-- ----------------------------------------------------------------------------
create or replace function public.tg_extensions_notify_monitor()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_event text;
  v_title text;
  v_verb  text;
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    v_event := 'extension_requested';
    v_title := 'Extension Requested';
    v_verb  := 'requested more time on';
    v_actor := new.requested_by;
  elsif new.status is distinct from old.status and new.status <> 'pending' then
    v_event := 'extension_' || new.status;   -- extension_approved | _rejected
    v_title := case new.status
                 when 'approved' then 'Extension Approved'
                 else 'Extension Rejected'
               end;
    v_verb  := case new.status
                 when 'approved' then 'approved more time on'
                 else 'rejected a request for more time on'
               end;
    v_actor := coalesce(new.reviewed_by, auth.uid());
  else
    return new;                              -- e.g. a comment on the request
  end if;

  perform public.notify_task_monitor(
    new.task_id, v_event, v_event, v_title, v_verb, v_actor,
    'mon:' || v_event || ':' || new.id::text
  );

  return new;
end;
$$;

drop trigger if exists extensions_notify_monitor on public.task_extensions;
create trigger extensions_notify_monitor
  after insert or update on public.task_extensions
  for each row execute function public.tg_extensions_notify_monitor();

-- ----------------------------------------------------------------------------
-- READ-ONLY MONITORING VIEW (server-enforced)
--
-- The Director/Super Admin monitoring screen must be read-only, and that has
-- to be true SERVER-SIDE, not just hidden in the UI. This function is the
-- authorised read path for that screen:
--
--   * it is STABLE - it cannot write, by construction
--   * it is SECURITY DEFINER, so the visibility test is evaluated by the
--     database rather than trusted from the client
--   * it returns exactly one snapshot (task + full history + comments) or
--     nothing at all when the caller may not see that task
--
-- A caller with no permitted relationship to the task gets NULL, so the read
-- itself is authorised server-side - the app cannot widen it by asking nicely.
--
-- HONEST LIMIT: this guarantees the monitoring SCREEN has no write path. It
-- cannot revoke the write that tasks_update already grants a director on the
-- tasks table, because the app legitimately needs that elsewhere. Closing that
-- last gap means moving every task write behind its own RPC, which is a
-- separate, riskier change - deliberately not bundled here.
-- ----------------------------------------------------------------------------
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
        t.assigned_to  = auth.uid()
     or t.assigned_by  = auth.uid()
     or t.created_by   = auth.uid()
     or public.is_director_or_admin()
     or public.is_self_or_downline(t.assigned_to)
      )
  )
  select jsonb_build_object(
    'task',     (select to_jsonb(p) from permitted p),
    'history',  coalesce(
                  (select jsonb_agg(to_jsonb(h) order by h.created_at desc)
                   from public.task_history h
                   join permitted p on p.id = h.task_id),
                  '[]'::jsonb),
    'comments', coalesce(
                  (select jsonb_agg(to_jsonb(c) order by c.created_at asc)
                   from public.task_comments c
                   join permitted p on p.id = c.task_id),
                  '[]'::jsonb)
  )
  from permitted
  limit 1;
$$;

revoke all on function public.task_monitoring_snapshot(uuid) from public;
grant execute on function public.task_monitoring_snapshot(uuid) to authenticated;

comment on function public.task_monitoring_snapshot(uuid) is
  'Authorised read-only snapshot (task + history + comments) for Director/Super Admin monitoring. Returns NULL when the caller may not see the task.';

    'mon:assigned:' || new.id::text
  );

  return new;
end;
$$;

drop trigger if exists tasks_notify_monitor_insert on public.tasks;
create trigger tasks_notify_monitor_insert
  after insert on public.tasks
  for each row execute function public.tg_tasks_notify_monitor_insert();

    coalesce(p_dedupe, 'mon:' || p_event || ':' || p_task_id::text)
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

revoke all on function public.notify_task_monitor(uuid, text, text, text, text, uuid, text) from public;
grant execute on function public.notify_task_monitor(uuid, text, text, text, text, uuid, text) to authenticated;
