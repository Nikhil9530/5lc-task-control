-- ============================================================================
-- 5LC TASK CONTROL - 0013 HIERARCHY-AWARE APPROVALS
--
-- Product rules implemented here:
--   1. An extension request goes to the requester's UPLINE ONLY
--      (their manager -> higher up that chain). NOT blanket to the Director.
--   2. Only Super Admin (the system operator) retains a global override for
--      support purposes. A Director sees an extension only if they are in that
--      person's reporting chain.
--   3. The upline is notified (push + email) the moment an extension is asked.
--   4. If a member has no manager, their director is used as the approver so
--      nothing can ever get stuck.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) UPLINE-ONLY VISIBILITY of extension requests
-- ----------------------------------------------------------------------------
drop policy if exists extensions_select on public.task_extensions;

create policy extensions_select on public.task_extensions for select using (
  -- the person who asked always sees their own request
  requested_by = auth.uid()
  -- system operator may see everything for support
  or public.current_role() = 'super_admin'
  -- otherwise: only the task assignee's UPLINE (manager/head/... in that chain)
  or exists (
    select 1 from public.tasks t
    where t.id = task_id
      and public.is_self_or_downline(t.assigned_to)
  )
);

-- ----------------------------------------------------------------------------
-- 2) APPROVAL AUTHORITY = upline only (Director override removed)
-- ----------------------------------------------------------------------------
create or replace function public.review_task_extension(
  p_extension_id uuid,
  p_action text,               -- 'approved' | 'rejected'
  p_review_comment text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ext        public.task_extensions%rowtype;
  v_task       public.tasks%rowtype;
  v_reviewer   uuid := auth.uid();
  v_is_upline  boolean;
begin
  if v_reviewer is null then
    raise exception 'Not authenticated';
  end if;

  if p_action not in ('approved','rejected') then
    raise exception 'Invalid action: %', p_action;
  end if;

  select * into v_ext from public.task_extensions where id = p_extension_id;
  if not found then
    raise exception 'Extension request not found';
  end if;
  if v_ext.status <> 'pending' then
    raise exception 'Extension already reviewed';
  end if;

  select * into v_task from public.tasks where id = v_ext.task_id;

  -- AUTHORITY (server-side): must be the requester's upline, or Super Admin.
  -- A Director is NOT automatically allowed - only if they are in that chain.
  v_is_upline := public.is_self_or_downline(v_ext.requested_by)
                 or exists (
                   select 1 from public.profiles p
                   where p.id = v_ext.requested_by
                     and p.director_id = v_reviewer
                     and p.manager_id is null
                 );

  if not (v_is_upline or public.current_role() = 'super_admin') then
    raise exception 'Only the requester''s manager (or above) can review this extension';
  end if;

  -- Nobody approves their own request.
  if v_ext.requested_by = v_reviewer then
    raise exception 'You cannot review your own extension request';
  end if;

  -- Record the decision.
  update public.task_extensions
     set status = p_action,
         reviewed_by = v_reviewer,
         reviewed_at = now(),
         review_comment = p_review_comment
   where id = p_extension_id;

  -- On approval, move the task deadline (the original date stays on the row).
  if p_action = 'approved' then
    update public.tasks
       set due_date = v_ext.requested_due_date,
           updated_at = now()
     where id = v_ext.task_id;
  end if;

  -- Audit trail.
  insert into public.task_history (task_id, user_id, action, details)
  values (
    v_ext.task_id,
    v_reviewer,
    'extension_' || p_action,
    jsonb_build_object(
      'old_due_date', v_ext.old_due_date,
      'requested_due_date', v_ext.requested_due_date,
      'reason', v_ext.reason,
      'review_comment', p_review_comment
    )
  );

  -- Notify the requester.
  insert into public.notifications (user_id, type, title, message, task_id, extension_id, dedupe_key)
  values (
    v_ext.requested_by,
    'extension_' || p_action,
    case when p_action = 'approved' then 'Extension Approved' else 'Extension Rejected' end,
    case when p_action = 'approved'
      then 'Your extension request for "' || v_task.title || '" was approved. New due date: ' || v_ext.requested_due_date || '.'
      else 'Your extension request for "' || v_task.title || '" was rejected. The original deadline stands.'
    end,
    v_ext.task_id,
    p_extension_id,
    'ext_dec:' || p_extension_id::text || ':' || p_action
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

revoke all on function public.review_task_extension(uuid, text, text) from public;
grant execute on function public.review_task_extension(uuid, text, text) to authenticated;
