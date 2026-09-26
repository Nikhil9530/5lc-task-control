-- ============================================================================
-- 5LC TASK CONTROL - 0020 TASK WORKFLOW GOVERNANCE
--
-- Fixes three real-world problems reported from the field:
--
--   1. TASK OWNERSHIP / "I can edit the guy's task"
--      `tasks_update` (migration 0004) allowed the ASSIGNER to update the row
--      with no column restriction, so a manager could drive the status of work
--      they had handed off - marking someone else's task completed, waiting or
--      not-started. Status is now OWNED BY THE ASSIGNEE.
--
--   2. NO WORKFLOW ORDER
--      Nothing stopped nonsense like waiting -> not_started. Status is now a
--      forward-only state machine; a completed task cannot quietly un-complete.
--
--   3. COMPLETION ONLY TOLD THE IMMEDIATE ASSIGNER
--      A director who delegated down a 3-level chain never learned it finished.
--      Completion now notifies the ENTIRE chain of command up to the director
--      (plus super admins).
--
-- DESIGN NOTES
--   * Governance lives in Postgres, not the APK, so it cannot be bypassed by
--     editing the app (same principle as migrations 0003/0004).
--   * `due_date` is deliberately NOT guarded as content: it is moved by
--     `review_task_extension()` when an extension is approved, which is the
--     sanctioned way to change a deadline. Guarding it would break approvals.
--   * Cron / service-role work has no `auth.uid()` and is exempt, because
--     scheduled jobs must still be able to maintain data.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Forward-only status state machine
-- ----------------------------------------------------------------------------
create or replace function public.task_status_is_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
as $$
  select case
    when p_from = p_to                then true
    when p_from = 'not_started'       then p_to in ('in_progress','waiting','completed','rejected')
    when p_from = 'in_progress'       then p_to in ('waiting','completed','rejected')
    -- 'waiting' may resume to in_progress or finish, but can NEVER go back to
    -- not_started: the work has already been started.
    when p_from = 'waiting'           then p_to in ('in_progress','completed','rejected')
    -- Reopening a finished task is a REVIEW decision, not a free-for-all; the
    -- trigger below restricts who may do it.
    when p_from = 'completed'         then p_to in ('in_progress')
    when p_from = 'rejected'          then p_to in ('in_progress')
    else false
  end;
$$;

comment on function public.task_status_is_allowed(text, text) is
  'Forward-only task workflow. Blocks waiting -> not_started and un-completing.';

revoke all on function public.task_status_is_allowed(text, text) from public;
grant execute on function public.task_status_is_allowed(text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 2. The full chain of command above a user (manager -> head -> director ...)
--    Unlike escalation_targets() this returns EVERY ancestor, ordered, with no
--    LIMIT, so completion notices reach the top.
-- ----------------------------------------------------------------------------
create or replace function public.upline_chain(p_user uuid)
returns table (user_id uuid, level int)
language sql
stable
security definer
set search_path = public
as $$
  with recursive chain as (
    select p.id, p.manager_id, 1 as depth
    from public.profiles p
    where p.id = p_user
    union all
    select m.id, m.manager_id, c.depth + 1
    from public.profiles m
    join chain c on m.id = c.manager_id
    where c.depth < 20            -- cycle guard
  )
  select id, depth - 1
  from chain
  where depth > 1;                -- exclude the user themselves
$$;

comment on function public.upline_chain(uuid) is
  'Every manager above p_user, level 1 = immediate manager. Used for completion notices.';

revoke all on function public.upline_chain(uuid) from public;
grant execute on function public.upline_chain(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. Enforce WHO may change WHAT on a task.
--
--    Assignee  -> reports progress:  in_progress | waiting | completed
--    Reviewer  -> the assigner, or anyone above the assignee in the chain:
--                 may send work back (rejected) or reopen it for rework.
--                 They may NOT mark someone else's work in-progress/completed.
--    Director  -> full override (needed for corrections).
--
--    As a BEFORE UPDATE trigger this runs before the row is written, so an
--    illegal update is rejected outright - the app cannot get around it.
--    Trigger ordering is irrelevant here: raising an exception rolls back the
--    whole transaction, including anything an earlier trigger inserted.
-- ----------------------------------------------------------------------------
create or replace function public.tg_tasks_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid               uuid := auth.uid();
  v_is_admin          boolean;
  v_actor_is_doer     boolean;
  v_actor_is_reviewer boolean;
  v_status_changed    boolean;
begin
  -- No JWT = pg_cron / service_role / migrations. Those must stay able to
  -- maintain data, so user-level governance does not apply.
  if v_uid is null then
    return new;
  end if;

  v_is_admin := public.is_director_or_admin();

  -- Identity is immutable through the API.
  if new.id is distinct from old.id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'A task''s identity fields cannot be changed.'
      using errcode = 'insufficient_privilege';
  end if;

  v_status_changed    := new.status is distinct from old.status;
  v_actor_is_doer     := (v_uid = old.assigned_to);
  -- is_self_or_downline(target) is true for the target itself too, but the
  -- doer branch is checked first, so reviewers here are genuinely "above".
  v_actor_is_reviewer := (v_uid = old.assigned_by)
                         or public.is_self_or_downline(old.assigned_to);

  -- ---- STATUS -------------------------------------------------------------
  if v_status_changed and not v_is_admin then

    -- Forward-only. This is what stops waiting -> not_started.
    if not public.task_status_is_allowed(old.status, new.status) then
      raise exception
        'Status cannot move from "%" back to "%". Tasks only move forward.',
        old.status, new.status
        using errcode = 'check_violation';
    end if;

    if v_actor_is_doer then
      -- The person doing the work reports progress and completion.
      if old.status = 'completed' then
        raise exception
          'This task is already completed. Only a manager or director can reopen it.'
          using errcode = 'insufficient_privilege';
      end if;

      if new.status not in ('in_progress','waiting','completed') then
        raise exception
          'A task can only be rejected by a manager or director.'
          using errcode = 'insufficient_privilege';
      end if;

    elsif v_actor_is_reviewer then
      -- A manager must not meddle with a task that has not been picked up yet -
      -- that was the "I can edit the guy's task" complaint. Once work has
      -- started they may reject it or send it back for rework; they still do
      -- NOT report progress on someone else's behalf.
      if old.status = 'not_started' then
        raise exception
          'This task has not been started yet, so there is nothing to review. A director can reassign or cancel it if that is what you need.'
          using errcode = 'insufficient_privilege';
      end if;

      if new.status not in ('rejected','in_progress') then
        raise exception
          'Only the person this task is assigned to can mark it "%". You can reject it or send it back for rework.',
          new.status
          using errcode = 'insufficient_privilege';
      end if;

    else
      raise exception 'You are not allowed to change the status of this task.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- ---- CONTENT ------------------------------------------------------------
  -- title / description / priority belong to whoever created the assignment.
  -- (due_date excluded on purpose - see the header note about extensions.)
  if not v_is_admin
     and (new.title           is distinct from old.title
          or new.description  is distinct from old.description
          or new.priority     is distinct from old.priority
          or new.parent_task_id is distinct from old.parent_task_id)
     and v_uid <> old.assigned_by
     and v_uid <> old.created_by then
    raise exception
      'Only the person who assigned this task can change its details. Use an extension request to move the date.'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- REASSIGNMENT -------------------------------------------------------
  if new.assigned_to is distinct from old.assigned_to
     and not v_is_admin
     and v_uid <> old.assigned_by then
    raise exception 'Only the person who assigned this task can hand it to someone else.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.tg_tasks_guard_update() is
  'Ownership + forward-only workflow guard for public.tasks.';

drop trigger if exists tasks_guard_update on public.tasks;
create trigger tasks_guard_update
  before update on public.tasks
  for each row execute function public.tg_tasks_guard_update();


-- ----------------------------------------------------------------------------
-- 4. Completion now travels the WHOLE chain of command.
--
--    Before: only `assigned_by` was told. If a director delegated A -> B -> C,
--    the director never heard that C finished.
--    Now: the assigner, every manager above the assignee, and all super admins
--    are notified. Overlapping roles are collapsed with UNION, and nobody is
--    notified about their own action.
--
--    dedupe_key is per (task, recipient) so one person gets at most one
--    completion notice per task - no notification storms when a task is
--    reopened and completed again.
-- ----------------------------------------------------------------------------
create or replace function public.tg_tasks_after_update()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if new.status is distinct from old.status then

    insert into public.task_history (task_id, user_id, action, details)
    values (
      new.id,
      v_actor,
      'status_changed',
      jsonb_build_object(
        'task_title', new.title,
        'from_status', old.status,
        'to_status', new.status
      )
    );

    -- ---- completed -> tell the chain of command ---------------------------
    if new.status = 'completed' then
      insert into public.notifications
        (user_id, type, title, message, task_id, dedupe_key)
      select
        r.user_id,
        'task_completed',
        'Task Completed',
        'Task "' || new.title || '" has been marked completed.',
        new.id,
        'completed:' || new.id::text || ':' || r.user_id::text
      from (
        -- the person who assigned it (may be null for self-created tasks)
        select new.assigned_by as user_id
        union
        -- every manager above the assignee
        select u.user_id from public.upline_chain(new.assigned_to) u
        union
        -- top-level oversight
        select p.id from public.profiles p where p.role = 'super_admin'
      ) r
      where r.user_id is not null
        and r.user_id <> new.assigned_to            -- don't tell the doer
        and (v_actor is null or r.user_id <> v_actor) -- don't tell the actor
      on conflict (dedupe_key) where dedupe_key is not null do nothing;
    end if;

    -- ---- rejected -> tell the person who has to redo it -------------------
    if new.status = 'rejected' then
      insert into public.notifications
        (user_id, type, title, message, task_id, dedupe_key)
      values (
        new.assigned_to,
        'task_rejected',
        'Task Rejected',
        'Task "' || new.title || '" was sent back for rework.',
        new.id,
        'rejected:' || new.id::text || ':' || new.assigned_to::text
      )
      on conflict (dedupe_key) where dedupe_key is not null do nothing;
    end if;

  end if;

  -- Keep updated_at accurate.
  new.updated_at := now();

  return new;
end;
$$;

drop trigger if exists tasks_after_update on public.tasks;
create trigger tasks_after_update
  before update on public.tasks
  for each row execute function public.tg_tasks_after_update();

