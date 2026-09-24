-- ============================================================================
-- 5LC TASK CONTROL - 0016 SELF-TASK CREATION FOR EVERYONE
--
-- Rule change: EVERYONE can create a task for THEMSELVES (personal to-do with
-- full tracking). Managers/Heads keep downline assignment; Directors keep
-- company-wide assignment.
--   Employee  -> only themselves
--   Head/Mgr  -> themselves + their downline
--   Director  -> anyone
-- ============================================================================

create or replace function public.can_assign_to(target uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    -- Everyone may create a task for themselves.
    when target = auth.uid() then true
    -- Director / Super Admin: company-wide.
    when public.is_director_or_admin() then true
    -- Head / Manager: their own downline.
    when public.current_role() in ('head','manager')
         then public.is_self_or_downline(target)
    else false
  end;
$$;

-- ----------------------------------------------------------------------------
-- Self-created tasks should NOT ping yourself with a notification.
-- (History is still recorded - only the notification is suppressed.)
-- ----------------------------------------------------------------------------
create or replace function public.tg_tasks_after_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.task_history (task_id, user_id, action, details)
  values (
    new.id,
    coalesce(new.assigned_by, new.created_by),
    'task_created',
    jsonb_build_object(
      'task_title', new.title,
      'priority', new.priority,
      'status', new.status,
      'due_date', new.due_date,
      'parent_task_id', new.parent_task_id
    )
  );

  -- Notify the assignee only when someone ELSE assigned the work.
  if new.assigned_to is distinct from new.assigned_by then
    insert into public.notifications (user_id, type, title, message, task_id, channel, dedupe_key)
    values (
      new.assigned_to,
      'task_assigned',
      case when new.parent_task_id is null then 'New Task Assigned' else 'New Sub-Task Assigned' end,
      case when new.parent_task_id is null
        then 'You have been assigned: "' || new.title || '"'
        else 'You have been delegated a sub-task: "' || new.title || '"'
      end,
      new.id,
      'both',
      'assign:' || new.id::text
    )
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end if;

  return new;
end;
$$;
