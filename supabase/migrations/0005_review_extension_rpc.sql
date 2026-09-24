-- ============================================================================
-- 5LC TASK CONTROL - 0005 review_task_extension() RPC
-- Approves/rejects an extension. The APK calls this; it re-verifies authority
-- SERVER-SIDE (never trusts the app), updates the task due date on approval,
-- and writes task_history automatically.
-- ============================================================================

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

  -- AUTHORITY CHECK (server-side): reviewer must be director/admin,
  -- or be above the task's assignee in the hierarchy.
  if not (
    public.is_director_or_admin()
    or public.is_self_or_downline(v_task.assigned_to)
  ) then
    raise exception 'You are not authorized to review this extension';
  end if;

  -- A reviewer cannot approve their own request.
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

  -- On approval, move the task deadline (original date stays on the extension row).
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

  -- Notify the requester (in-app record; push/email dispatch is separate).
  insert into public.notifications (user_id, type, title, message, task_id, extension_id)
  values (
    v_ext.requested_by,
    'extension_' || p_action,
    case when p_action = 'approved' then 'Extension Approved' else 'Extension Rejected' end,
    case when p_action = 'approved'
      then 'Your extension request for "' || v_task.title || '" was approved. New due date: ' || v_ext.requested_due_date || '.'
      else 'Your extension request for "' || v_task.title || '" was rejected. The original deadline stands.'
    end,
    v_ext.task_id,
    p_extension_id
  );
end;
$$;

revoke all on function public.review_task_extension(uuid, text, text) from public;
grant execute on function public.review_task_extension(uuid, text, text) to authenticated;
