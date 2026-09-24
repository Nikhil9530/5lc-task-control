-- ============================================================================
-- 5LC TASK CONTROL - 0010 AUTOMATIC HISTORY + ASSIGNMENT NOTIFICATIONS
-- History and assignment notices are written by TRIGGERS, so the audit trail
-- can never be skipped by the app (blueprint: history must be reliable).
-- ============================================================================

-- On task creation: record history + notify the assignee immediately.
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

  insert into public.notifications (user_id, type, title, message, task_id, dedupe_key)
  values (
    new.assigned_to,
    'task_assigned',
    case when new.parent_task_id is null then 'New Task Assigned' else 'New Sub-Task Assigned' end,
    case when new.parent_task_id is null
      then 'You have been assigned: "' || new.title || '"'
      else 'You have been delegated a sub-task: "' || new.title || '"'
    end,
    new.id,
    'assign:' || new.id::text
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing;

  return new;
end;
$$;

drop trigger if exists tasks_after_insert on public.tasks;
create trigger tasks_after_insert
  after insert on public.tasks
  for each row execute function public.tg_tasks_after_insert();

-- On status change: record history; notify the assigner when completed.
create or replace function public.tg_tasks_after_update()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    insert into public.task_history (task_id, user_id, action, details)
    values (
      new.id,
      auth.uid(),
      'status_changed',
      jsonb_build_object(
        'task_title', new.title,
        'from_status', old.status,
        'to_status', new.status
      )
    );

    -- Completion notice to the person who assigned it (if someone else).
    if new.status = 'completed'
       and new.assigned_by is not null
       and new.assigned_by <> new.assigned_to then
      insert into public.notifications (user_id, type, title, message, task_id, dedupe_key)
      values (
        new.assigned_by,
        'task_completed',
        'Task Completed',
        'Task "' || new.title || '" has been marked completed.',
        new.id,
        'completed:' || new.id::text
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

-- On reassignment: record who handed it off (delegation accountability).
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

    insert into public.notifications (user_id, type, title, message, task_id, dedupe_key)
    values (
      new.assigned_to,
      'task_assigned',
      'Task Assigned To You',
      'You have been assigned: "' || new.title || '"',
      new.id,
      'assign:' || new.id::text || ':' || new.assigned_to::text
    )
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_after_reassign on public.tasks;
create trigger tasks_after_reassign
  after update on public.tasks
  for each row execute function public.tg_tasks_after_reassign();
