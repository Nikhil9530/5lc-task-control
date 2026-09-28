-- ============================================================================
-- 5LC TASK CONTROL - 0023 DIRECT-ASSIGNMENT PERMISSIONS
--
-- WHY THIS EXISTS
-- ---------------
-- The app is moving from a HIERARCHY model to a DIRECT-ASSIGNMENT model.
-- Section "L" of the requirements is explicit: fix the database first,
-- because hiding buttons in React Native is not security.
--
-- WHAT CHANGES
--   1. can_assign_to()  -> anyone may assign to anyone, EXCEPT that a
--                          Director may only be targeted by a Director /
--                          Super Admin, and a Super Admin may only be
--                          targeted by themselves. Self-assignment is
--                          always allowed.
--   2. Personal tasks   -> a task assigned to the person who assigned it
--                          is PRIVATE to that person. Nobody else sees it,
--                          including other Directors and Super Admins.
--   3. Editing          -> the CURRENT ASSIGNEE is the only editor.
--                          The assigner/creator can no longer edit.
--   4. Comments         -> participants only (+ directors on non-personal).
--   5. Extensions       -> only the current assignee may request one.
--   6. Hierarchy        -> is_self_or_downline() is removed from every
--                          VISIBILITY decision.
--   7. Directory        -> every signed-in user may read public.profiles.
--   8. dashboard_counts -> same privacy rules, so the number on a KPI card
--                          still equals the length of the list it opens.
--
-- WHAT IS DELIBERATELY UNCHANGED
--   1. Workflow authority. Completion review / accept / reject and extension
--      approval / rejection stay exactly where they are. Removing someone's
--      ability to EDIT a task must not remove their ability to REVIEW it.
--      So tg_tasks_guard_update() keeps its reviewer and admin status paths,
--      and review_task_extension() is untouched.
--   2. Notification timing, and the rejected/waiting reminder behaviour.
--      Those are a separate change and are not part of 0023.
--
-- HOW TO RUN THIS FILE
-- --------------------
-- Supabase -> SQL Editor. Run ONE BLOCK AT A TIME, in order 1 -> 10.
-- Every block is idempotent, so re-running a block is safe.
--
-- Two things about the SQL editor that will waste your time if you forget:
--   * Paste a WHOLE block. If a block is cut in half you get
--     "unterminated dollar-quoted string" - that is a paste problem,
--     not a syntax problem.
--   * Wait for each block to report success before pasting the next one.
--
-- BEFORE YOU RUN THIS, READ THIS CONSEQUENCE
-- ------------------------------------------
-- Two screens are built on the hierarchy that this migration removes:
--
--   * src/app/team.tsx:129  counts open tasks per member. The roster still
--                           loads (it filters profiles client-side), but
--                           DOWNLINE COUNTS BECOME 0.
--   * src/app/member-tasks.tsx:167  reads .eq('assigned_to', memberId), so a
--                           manager opening a downline member gets an
--                           EMPTY task list.
--
-- That is not a bug in 0023 - it is what "no hierarchy" means. But those two
-- screens must be re-based on the direct-assignment model in the UI phase.
-- They are called out here so the change is never a surprise.
-- ============================================================================


-- ============================================================================
-- BLOCK 1  -  is_personal_assignment() + can_assign_to()
-- ============================================================================

-- A task is PERSONAL when it is assigned to the same person who assigned it.
-- (Employee -> Employee, Director -> Director, and so on.)
-- Plain SQL, immutable, no table access, so it is cheap enough to call inside
-- RLS policies for every row.
create or replace function public.is_personal_assignment(
  p_assigned_to uuid,
  p_assigned_by uuid,
  p_created_by uuid
)
returns boolean
language sql
immutable
as $$
  select p_assigned_to is not null
     and p_assigned_to = coalesce(p_assigned_by, p_created_by);
$$;

comment on function public.is_personal_assignment(uuid, uuid, uuid) is
  'True when a task is assigned to the same person who assigned it.';

revoke all on function public.is_personal_assignment(
  uuid, uuid, uuid) from public;
grant execute on function public.is_personal_assignment(
  uuid, uuid, uuid) to authenticated;

-- FINAL assignment rules. Every case below comes from the confirmed list:
--   Director 1 -> Director 2   allowed
--   Employee   -> Employee     allowed
--   Employee   -> Manager      allowed
--   Manager    -> Head         allowed
--   Employee   -> Director     BLOCKED
--   Manager    -> Director     BLOCKED
--   Director   -> Super Admin  BLOCKED
--   Anyone     -> Super Admin  BLOCKED
--   Anyone     -> themselves   allowed (this is a personal task)
create or replace function public.can_assign_to(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    -- 1. No such person -> no. This also covers a null target.
    when not exists (
      select 1 from public.profiles p where p.id = target
    ) then false

    -- 2. Self-assignment is allowed for EVERY role. This is what makes a
    --    personal task possible, so it must be checked before the role gates.
    when target = auth.uid() then true

    -- 3. A Super Admin is never the target of a normal assignment.
    when (select p.role from public.profiles p
           where p.id = target) = 'super_admin' then false

    -- 4. A Director may only be targeted by a Director / Super Admin.
    when (select p.role from public.profiles p
           where p.id = target) = 'director'
      then public.current_role() in ('director', 'super_admin')

    -- 5. Everyone else: any signed-in user may assign to them.
    --    (current_role() is '' when the caller has no profile - fail closed.)
    else public.current_role() <> ''
  end;
$$;

comment on function public.can_assign_to(uuid) is
  'Direct-assignment rules: anyone may assign to anyone, except that a '
  'Director requires a Director/Super Admin, and a Super Admin may only '
  'be assigned to by themselves.';

revoke all on function public.can_assign_to(uuid) from public;
grant execute on function public.can_assign_to(uuid) to authenticated;

-- ============================================================================
-- BLOCK 2  -  EMPLOYEE DIRECTORY OPEN TO EVERY SIGNED-IN USER
--
-- Requirement G: the directory exists so people can FIND each other. Seeing
-- someone in the directory grants NOTHING - it does not let you see or edit
-- their tasks. Task access is decided by the policies in blocks 3-7.
--
-- Before 0023 this policy was: self, or director, or your own downline.
-- An Employee therefore saw only themselves, which made the assignee picker
-- useless for the Employee -> Employee case.
-- ============================================================================

drop policy if exists profiles_select on public.profiles;

create policy profiles_select on public.profiles for select using (
  auth.uid() is not null
);

-- ============================================================================
-- BLOCK 3  -  tasks_select : PERSONAL-TASK PRIVACY + NO HIERARCHY
--
-- The rule, in order:
--   * A PERSONAL task (assigned to the person who assigned it) is visible to
--     its owner and to NOBODY ELSE. Not other Directors, not Super Admin.
--   * Any OTHER task is visible to the people involved - the assignee, the
--     assigner, the creator - plus Directors / Super Admins, who monitor the
--     whole company.
--
-- is_self_or_downline() is gone from this policy. That is requirement D.
-- ============================================================================

drop policy if exists tasks_select on public.tasks;

create policy tasks_select on public.tasks for select using (
  case
    -- Personal task -> owner only. This branch deliberately ignores role,
    -- so a Director cannot read another Director's personal task and a
    -- Super Admin cannot read anyone's personal task.
    when public.is_personal_assignment(
           assigned_to, assigned_by, created_by)
      then assigned_to = auth.uid()

    -- Company / assigned task -> the parties, plus company-wide roles.
    else
      assigned_to = auth.uid()
      or assigned_by = auth.uid()
      or created_by = auth.uid()
      or public.is_director_or_admin()
  end
);

-- ============================================================================
-- BLOCK 4  -  tasks_update + tasks_delete
--
-- Row-level gate: can I touch this row at all?
--   * A personal task can only be touched by its owner.
--   * Otherwise the parties and company-wide roles may touch it.
--
-- This is the ROW gate. WHICH COLUMNS may change, and by whom, is decided by
-- tg_tasks_guard_update() in block 9 - that is where "the current assignee is
-- the only editor" is actually enforced.
-- ============================================================================

drop policy if exists tasks_update on public.tasks;

create policy tasks_update on public.tasks for update
  using (
    case
      when public.is_personal_assignment(
             assigned_to, assigned_by, created_by)
        then assigned_to = auth.uid()
      else
        assigned_to = auth.uid()
        or assigned_by = auth.uid()
        or created_by = auth.uid()
        or public.is_director_or_admin()
    end
  )
  with check (
    case
      when public.is_personal_assignment(
             assigned_to, assigned_by, created_by)
        then assigned_to = auth.uid()
      else
        assigned_to = auth.uid()
        or assigned_by = auth.uid()
        or created_by = auth.uid()
        or public.is_director_or_admin()
    end
  );

drop policy if exists tasks_delete on public.tasks;

-- Deleting follows the same shape as updating. The personal-task branch is
-- what stops a Director deleting a personal task they are not allowed to see.
create policy tasks_delete on public.tasks for delete using (
  case
    when public.is_personal_assignment(
           assigned_to, assigned_by, created_by)
      then assigned_to = auth.uid()
    else
      assigned_to = auth.uid()
      or assigned_by = auth.uid()
      or public.is_director_or_admin()
  end
);

-- ============================================================================
-- BLOCK 5  -  COMMENTS: participant check
--
-- Requirement I15: comments are how a Director and an Employee communicate on
-- an assigned task - Director: comment YES / edit NO. So comments must stay
-- open to participants, but must NOT be open to the whole company.
--
-- SECURITY HOLE CLOSED HERE
-- The old insert policy checked ONLY `user_id = auth.uid()`. It never checked
-- that the commenter had anything to do with the task, so any signed-in user
-- who knew a task UUID could post a comment on it. Now the task must actually
-- involve you.
--
-- Directors may additionally comment on any NON-PERSONAL company task, which
-- is what keeps the monitoring view usable (requirement I16). They still
-- cannot reach anybody's private personal task.
-- ============================================================================

drop policy if exists comments_select on public.task_comments;

create policy comments_select on public.task_comments for select using (
  exists (
    select 1 from public.tasks t
    where t.id = task_id
      and (
        case
          when public.is_personal_assignment(
                 t.assigned_to, t.assigned_by, t.created_by)
            then t.assigned_to = auth.uid()
          else
            t.assigned_to = auth.uid()
            or t.assigned_by = auth.uid()
            or t.created_by = auth.uid()
            or public.is_director_or_admin()
        end
      )
  )
);

drop policy if exists comments_insert on public.task_comments;

create policy comments_insert on public.task_comments for insert with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.tasks t
    where t.id = task_id
      and (
        t.assigned_to = auth.uid()
        or t.assigned_by = auth.uid()
        or t.created_by = auth.uid()
        or (
          public.is_director_or_admin()
          and not public.is_personal_assignment(
                    t.assigned_to, t.assigned_by, t.created_by)
        )
      )
  )
);

-- ============================================================================
-- BLOCK 6  -  EXTENSIONS
--
-- Requirement J17: an extension belongs to the ASSIGNEE. On a task that
-- Director -> Employee, the Employee requests more time. The Director cannot
-- request an extension "on behalf of" the assignee.
--
-- SECURITY HOLE CLOSED HERE
-- The old insert policy checked ONLY `requested_by = auth.uid()`. It never
-- checked that you were the person doing the work, so ANY user could file an
-- extension against ANY task. Now you must be the current assignee.
--
-- The review side is untouched: approve/reject still goes through
-- review_task_extension(), which re-checks authority server-side.
-- ============================================================================

drop policy if exists extensions_select on public.task_extensions;

create policy extensions_select on public.task_extensions for select using (
  requested_by = auth.uid()
  or exists (
    select 1 from public.tasks t
    where t.id = task_id
      and (
        t.assigned_to = auth.uid()
        or t.assigned_by = auth.uid()
        or t.created_by = auth.uid()
        or (
          public.is_director_or_admin()
          and not public.is_personal_assignment(
                    t.assigned_to, t.assigned_by, t.created_by)
        )
      )
  )
);

drop policy if exists extensions_insert on public.task_extensions;

create policy extensions_insert on public.task_extensions for insert with check (
  requested_by = auth.uid()
  and exists (
    select 1 from public.tasks t
    where t.id = task_id
      and t.assigned_to = auth.uid()
  )
);

-- ============================================================================
-- BLOCK 7  -  TASK HISTORY
--
-- Same visibility shape as comments, so the activity trail on a task is
-- exactly as private as the task itself. is_self_or_downline() removed.
--
-- The insert check is tightened for the same reason as comments: it used to
-- be `user_id = auth.uid()` alone, which let any signed-in user write history
-- rows against any task. The triggers that record history run as the table
-- owner (SECURITY DEFINER), so they are unaffected by this change.
-- ============================================================================

drop policy if exists history_select on public.task_history;

create policy history_select on public.task_history for select using (
  exists (
    select 1 from public.tasks t
    where t.id = task_id
      and (
        case
          when public.is_personal_assignment(
                 t.assigned_to, t.assigned_by, t.created_by)
            then t.assigned_to = auth.uid()
          else
            t.assigned_to = auth.uid()
            or t.assigned_by = auth.uid()
            or t.created_by = auth.uid()
            or public.is_director_or_admin()
        end
      )
  )
);

drop policy if exists history_insert on public.task_history;

create policy history_insert on public.task_history for insert with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.tasks t
    where t.id = task_id
      and (
        t.assigned_to = auth.uid()
        or t.assigned_by = auth.uid()
        or t.created_by = auth.uid()
        or (
          public.is_director_or_admin()
          and not public.is_personal_assignment(
                    t.assigned_to, t.assigned_by, t.created_by)
        )
      )
  )
);

-- ============================================================================
-- BLOCK 8  -  RECURRING TASK TEMPLATES
--
-- Same hierarchy removal. The old policy granted `is_self_or_downline()`.
--
-- NOTE: recurring_write already uses public.can_assign_to(), so block 1
-- automatically re-scopes who may create a template. Nothing else to do here.
-- ============================================================================

drop policy if exists recurring_select on public.recurring_tasks;

create policy recurring_select on public.recurring_tasks for select using (
  assigned_to = auth.uid()
  or assigned_by = auth.uid()
  or public.is_director_or_admin()
);

-- ============================================================================
-- BLOCK 9  -  tg_tasks_guard_update() : WHO MAY EDIT, AND WHAT
--
-- This is where "the current assignee is the only task editor" is enforced.
-- RLS decides which ROWS you may touch; this BEFORE UPDATE trigger decides
-- which CHANGES are legal. An illegal change raises immediately, so the app
-- cannot get around it by calling the API directly.
--
-- THREE CHANGES FROM 0020
--   1. CONTENT (title / description / priority / parent_task_id) may now be
--      changed ONLY by the CURRENT ASSIGNEE. In 0020 this was the reverse -
--      the assigner/creator owned those fields. The requirement is explicit:
--      assigner NO, assignee YES, other managers NO, Super Admin NO.
--      Admin override is gone from this branch too, so a Director can no
--      longer edit a task they merely assigned.
--   2. REASSIGNMENT now re-checks public.can_assign_to(new.assigned_to).
--      Closing a real hole: the old rule only asked "are you allowed to hand
--      this on?" and never "are you allowed to hand it to THAT person?" - so
--      anyone could push a task onto a Director.
--   3. Nothing else moves. Status transitions, the reviewer path and the
--      admin override on STATUS are all preserved, because requirement 1 says
--      review/accept/reject authority must survive the editing change.
--
-- due_date stays OUT of the guarded content set on purpose: extensions own
-- the deadline, and review_task_extension() writes it. Guarding it here would
-- break extension approval.
-- ============================================================================

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
  -- UNCHANGED FROM 0020 ON PURPOSE: this is WORKFLOW authority (who may
  -- accept/reject), not task visibility, so the hierarchy clause stays until
  -- the review workflow itself is re-based on direct assignment.
  v_actor_is_reviewer := (v_uid = old.assigned_by)
                         or public.is_self_or_downline(old.assigned_to);

  -- ---- STATUS -------------------------------------------------------------
  -- UNCHANGED from 0020. Forward-only transitions; the doer reports progress;
  -- a reviewer may reject or send back; a director keeps full override.
  if v_status_changed and not v_is_admin then

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
          'This task is already completed. Only a manager or director '
          'can reopen it.'
          using errcode = 'insufficient_privilege';
      end if;

      if new.status not in ('in_progress','waiting','completed') then
        raise exception
          'A task can only be rejected by a manager or director.'
          using errcode = 'insufficient_privilege';
      end if;

    elsif v_actor_is_reviewer then
      if old.status = 'not_started' then
        raise exception
          'This task has not been started yet, so there is nothing to '
          'review. A director can reassign or cancel it if that is what '
          'you need.'
          using errcode = 'insufficient_privilege';
      end if;

      if new.status not in ('rejected','in_progress') then
        raise exception
          'Only the person this task is assigned to can mark it "%". '
          'You can reject it or send it back for rework.',
          new.status
          using errcode = 'insufficient_privilege';
      end if;

    else
      raise exception 'You are not allowed to change the status of this task.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- ---- CONTENT : CHANGED IN 0023 ------------------------------------------
  -- Only the CURRENT ASSIGNEE may edit the task itself. There is no admin
  -- escape here: a director who merely assigned the task is not its editor.
  -- title / description / priority / parent_task_id only.
  -- (due_date is deliberately absent - extensions own the deadline.)
  if (new.title            is distinct from old.title
      or new.description   is distinct from old.description
      or new.priority      is distinct from old.priority
      or new.parent_task_id is distinct from old.parent_task_id)
     and v_uid <> old.assigned_to then
    raise exception
      'Only the person this task is assigned to can edit it. '
      'Use comments to ask them to change something.'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- REASSIGNMENT -------------------------------------------------------
  -- The assigner (or a director) may still hand the task to somebody else -
  -- that is workflow authority, not editing. But the NEW target is now
  -- validated against the same direct-assignment rules as a fresh assignment.
  if new.assigned_to is distinct from old.assigned_to then

    if not v_is_admin and v_uid <> old.assigned_by then
      raise exception
        'Only the person who assigned this task can hand it to someone else.'
        using errcode = 'insufficient_privilege';
    end if;

    if not public.can_assign_to(new.assigned_to) then
      raise exception
        'You are not allowed to assign work to that person.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.tg_tasks_guard_update() is
  'Ownership + forward-only workflow guard. 0023: the current assignee '
  'is the only task editor; reassignment is re-validated with '
  'can_assign_to().';

-- Recreate the trigger so the new function body is the one that runs.
drop trigger if exists tasks_guard_update on public.tasks;

create trigger tasks_guard_update
  before update on public.tasks
  for each row execute function public.tg_tasks_guard_update();

-- ============================================================================
-- BLOCK 10  -  dashboard_counts() : SAME PRIVACY RULES AS THE LIST
--
-- The KPI numbers and the list a KPI opens MUST use identical predicates,
-- otherwise the number on the card disagrees with the list length.
--
-- The WHERE clause below is a deliberate copy of tasks_select in block 3.
-- It is redundant while the function stays `security invoker` (RLS already
-- filters), but keeping it explicit means the two can never drift apart if
-- anybody ever changes the function to `security definer`.
--
-- What this fixes: a Director's company-wide KPI no longer counts another
-- person's PRIVATE personal task as part of "the company".
-- ============================================================================

create or replace function public.dashboard_counts(p_today date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'active',          count(*) filter (where t.status <> 'completed'),
    'due_today',       count(*) filter (where t.due_date = p_today
                                        and t.status <> 'completed'),
    'overdue',         count(*) filter (where t.due_date < p_today
                                        and t.status <> 'completed'),
    'completed_today', count(*) filter (where t.status = 'completed'
                                        and t.completed_at >=
                                            (p_today::timestamp
                                             at time zone 'UTC')),
    'not_started',     count(*) filter (where t.status = 'not_started'),
    'in_progress',     count(*) filter (where t.status = 'in_progress'),
    'waiting',         count(*) filter (where t.status = 'waiting')
  )
  from public.tasks t
  where
    case
      -- Somebody else's personal task is not part of anyone's company view.
      when public.is_personal_assignment(
             t.assigned_to, t.assigned_by, t.created_by)
        then t.assigned_to = auth.uid()
      else
        t.assigned_to = auth.uid()
        or t.assigned_by = auth.uid()
        or t.created_by = auth.uid()
        or public.is_director_or_admin()
    end;
$$;

comment on function public.dashboard_counts(date) is
  'Single-round-trip KPI counts. Respects RLS (security invoker) and '
  'mirrors the tasks_select privacy rules from 0023.';

revoke all on function public.dashboard_counts(date) from public;
grant execute on function public.dashboard_counts(date) to authenticated;


-- ============================================================================
-- END OF 0023
--
-- WHAT THIS MIGRATION DID NOT DO (on purpose - separate changes)
--   1. Notification timing. The daily reminder still runs once at
--      03:30 UTC (09:00 IST), and the second due-today / overdue reminder is
--      not added. That is the next notification migration.
--   2. Reminder scope for `rejected` and `waiting` tasks is unchanged.
--   3. Extension REVIEW authority. review_task_extension() still decides who
--      may approve using the hierarchy, exactly as it does today. Requesting
--      is now assignee-only, which is what 0023 set out to do. Re-basing the
--      approval step on direct assignment is the follow-up.
--   4. The two hierarchy-based screens flagged at the top of this file are
--      still hierarchy-based. They belong to the UI phase.
--
-- VERIFY BEFORE TOUCHING THE UI
--   Run supabase/diagnostics/verify_permissions_rowset.sql and read the
--   results. It is read-only (apart from a small test harness it drops again).
-- ============================================================================
