-- ============================================================================
-- 5LC TASK CONTROL - 0029 COMPLETION NOTICES: ONLY THE TWO PARTIES
--
-- THE RULE BEING ENFORCED
-- -----------------------
--   A person is notified about a task ONLY IF they are the one it is assigned
--   to, or the one who assigned it.
--
--     notified(t)  <=>  t.assigned_to = me  OR  t.assigned_by = me
--
-- Audited by supabase/diagnostics/verify_notification_scope.sql. Block E of
-- that file returns one row per breach; it returned exactly one, and this is
-- the fix for it.
--
-- WHAT WAS ACTUALLY RUNNING
-- -------------------------
-- 0020 replaced 0010's `tg_tasks_after_update` - and both files end with
-- `drop trigger if exists tasks_after_update` followed by a `create trigger`,
-- so the LATER definition wins and 0020's body is what executes. Its
-- completion branch notified three groups:
--
--     select new.assigned_by                      -- the assigner      ok
--     union
--     select u.user_id from upline_chain(...)      -- managers above  NOT ok
--     union
--     select p.id from profiles where role =       -- every super_admin NOT ok
--            'super_admin'
--
-- The second and third groups are people who neither own the task nor handed
-- it over. With one super admin that is one stray notification per
-- completion; with five it fans out to all five on every task in the company.
--
-- The observed violation was a super_admin named in a completion message for
-- a task they had no relationship to.
--
-- ESCALATION AND EXTENSION REQUESTS WERE CHECKED AND ARE NOT AFFECTED
-- -------------------------------------------------------------------
-- The audit also covered `escalation` (0025 block 3b) and
-- `extension_requested` (0014), both of which reach people outside the two
-- parties by design. Neither has ever fired on this database - the audit
-- returned zero rows for both - so they are left alone. If either starts
-- firing, the same rule will flag it and the fix is the same shape as this
-- one: retarget to assigned_by.
--
-- WHAT THIS CHANGES
-- -----------------
-- The completion branch now notifies `assigned_by` only, keeping both of
-- 0020's existing guards:
--   * `r.user_id <> new.assigned_to`  - never tell the person who did it
--   * `r.user_id <> v_actor`          - never tell whoever pressed the button
-- The per-(task, recipient) dedupe_key is also kept, so a task reopened and
-- completed again still produces exactly one notice.
--
-- Nothing else moves: status_changed history rows, the rejected branch, the
-- monitor pings, and the completion notice to the assigner are untouched.
--
-- WHY A NEW FILE RATHER THAN AN EDIT TO 0020
-- ------------------------------------------
-- 0020 is APPLIED HISTORY. Editing it would make the repo describe a system
-- that never ran, and 0026 already records three incidents of this repo
-- drifting from the live database. This file restates the whole function so
-- the live body and the repo body are identical again.
--
-- HOW TO RUN
--   Supabase -> SQL Editor, BLOCK 1 then BLOCK 2. SQL only: no app change, no
--   OTA, nothing to rebuild.
-- ============================================================================



-- ============================================================================
-- BLOCK 1  -  THE CORRECTED FUNCTION
--
-- The full function is restated, not patched, because `create or replace`
-- must supply the entire body. The header and both guards are 0020's, with
-- only the recipient set changed.
-- ============================================================================

create or replace function public.tg_tasks_after_update()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid;
begin
  v_actor := auth.uid();

  -- History: who changed the status, and between what.
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

    -- completed -> tell the person who assigned it, and nobody else.
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
        -- THE ONLY RECIPIENT. Changed in 0029: the assigner, full stop.
        --
        -- 0020 had three groups here - assigned_by, upline_chain() of the
        -- assignee, and every super_admin. The latter two notify people who
        -- neither own the task nor handed it over: the rule breach.
        --
        -- Kept as a `select ... from (values)` rather than a plain `values`
        -- so the row still passes through both guards below uniformly.
        -- assigned_by is NULL on some self-created rows and the is-not-null
        -- guard drops those, rather than attempting a NULL recipient that the
        -- notifications.user_id NOT NULL constraint would reject anyway.
        select new.assigned_by as user_id
      ) r
      where r.user_id is not null
        and r.user_id <> new.assigned_to    -- don't tell the doer
        and (v_actor is null or r.user_id <> v_actor) -- don't tell the actor
      on conflict (dedupe_key) where dedupe_key is not null do nothing;
    end if;

    -- rejected -> tell the person who has to redo it
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


-- ============================================================================
-- BLOCK 2  -  VERIFY
--
-- 2a) THE FUNCTION BODY. The completion branch must now contain ONE recipient
--     expression. These four must all be ABSENT from the output:
--
--       upline_chain        <- the managers-above leak
--       super_admin         <- the company-wide leak
--       union               <- there is nothing left to union with
--
--     If `upline_chain` or `super_admin` still appears, block 1 did not apply
--     and the breach is still live.
-- ============================================================================

select pg_get_functiondef(
  'public.tg_tasks_after_update()'::regprocedure
);


-- ============================================================================
-- 2b) THE TRIGGER STILL EXISTS AND IS STILL WIRED. `create or replace` on the
--     function does not touch the trigger, but confirm it anyway - a missing
--     trigger would mean no status history and no completion notices at all,
--     which is worse than the breach this file removes.
--
-- Expect exactly one row: tasks_after_update, BEFORE UPDATE, enabled.
-- ============================================================================

select
  tgname,
  pg_get_triggerdef(oid) as definition,
  tgenabled
from pg_trigger
where tgrelid = 'public.tasks'::regclass
  and tgname = 'tasks_after_update'
  and not tgisinternal;


-- ============================================================================
-- 2c) THE TRIGGER FUNCTION IS STILL SECURITY DEFINER AND STILL LOCKED DOWN.
--
-- Expect security_definer = true. If this ever reads false, the history and
-- notification inserts would run as the calling role and fail for non-owners.
-- ============================================================================

select
  p.proname,
  p.prosecdef as security_definer,
  p.provolatile
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'tg_tasks_after_update';


-- ============================================================================
-- 2d) THE HISTORIC BREACH IS STILL ON RECORD, AND THAT IS EXPECTED.
--
-- This file changes what happens NEXT; it cannot un-send the notification
-- already delivered. The single pre-existing violation stays in the table
-- until pruned, so this query will keep returning one row for that old
-- message until `prune_notifications` removes it (0021 keeps unread rows for
-- 30 days).
--
-- Expect AT MOST the one row dated 2026-09-29 - the one you already saw.
-- Any row dated after you applied this file is a NEW breach and must be
-- investigated immediately.
-- ============================================================================

select
  n.type,
  n.created_at::date as sent_on,
  t.title,
  p.full_name as notified_person,
  p.role as their_role
from public.notifications n
join public.tasks t on t.id = n.task_id
join public.profiles p on p.id = n.user_id
where n.user_id is distinct from t.assigned_to
  and n.user_id is distinct from t.assigned_by
  and n.type = 'task_completed'
order by n.created_at desc;


-- ============================================================================
-- END OF 0029
--
-- AFTER APPLYING
--   The next task completion notifies its assigned_by only. Nobody above the
--   assignee and no unrelated super_admin is told.
--
-- TO CONFIRM IT WORKED
--   Complete one task assigned to you by someone else. Exactly one
--   `task_completed` notification should appear, addressed to your assigner.
--   Re-run 2d afterwards: no row dated today means the fix holds.
--
-- IF YOU WANT THE OLD MESSAGE GONE
--   Optional. The stray notification is already in the recipient's inbox:
--
--     delete from public.notifications
--     where id = '8c9888dc-2b34-462b-869e-6058c5dff043';
--
--   Omit it if you would rather keep the audit trail. It expires on its own
--   via prune_notifications.
--
-- WHAT THIS DID NOT CHANGE
--   * The completion notice TO the assigner - that already worked.
--   * The rejected notice, which only ever went to assigned_to.
--   * Status-change history rows.
--   * Monitor pings (0022/0026), reminders (0025), escalation, or extension
--     requests.
--   * Any RLS policy. SQL only, no app change, no OTA.
-- ============================================================================
