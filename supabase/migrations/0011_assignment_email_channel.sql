-- ============================================================================
-- 5LC TASK CONTROL - 0011 ASSIGNMENT NOTIFICATIONS = PUSH + EMAIL
-- Assignment (and reassignment) notifications are delivered through BOTH the
-- app (FCM push) AND email. The dispatch-notifications function reads the
-- channel column and sends accordingly.
-- ============================================================================

-- Re-create the insert trigger function with channel = 'both'.
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

  return new;
end;
$$;

-- Re-create the reassignment trigger function with channel = 'both' too.
create or replace function public.tg_tasks_after_reassign()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.assigned_to is distinct from old.assigned_to then
    insert into public.task_history (task_id, user_id, action, details)
    values (
      new.id,
      auth.uid(),
      'task_reassigned',
      jsonb_build_object('task_title', new.title, 'from_user', old.assigned_to, 'to_user', new.assigned_to)
    );

    insert into public.notifications (user_id, type, title, message, task_id, channel, dedupe_key)
    values (
      new.assigned_to,
      'task_assigned',
      'Task Assigned To You',
      'You have been assigned: "' || new.title || '"',
      new.id,
      'both',
      'assign:' || new.id::text || ':' || new.assigned_to::text
    )
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end if;

  return new;
end;
$$;
