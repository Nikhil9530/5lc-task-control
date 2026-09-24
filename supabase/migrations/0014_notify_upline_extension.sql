-- ============================================================================
-- 5LC TASK CONTROL - 0014 EXTENSION REQUEST -> NOTIFY THE UPLINE
-- The moment a member asks for more time, their manager (or director if they
-- have no manager) is notified by push + email. Not the whole company.
-- ============================================================================

create or replace function public.tg_extension_requested()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_approver uuid;
  v_requester_name text;
  v_task_title text;
begin
  -- Who should approve: the requester's manager, else their director.
  select coalesce(p.manager_id, p.director_id), p.full_name
    into v_approver, v_requester_name
  from public.profiles p
  where p.id = new.requested_by;

  if v_approver is null then
    return new; -- nobody to notify
  end if;

  select title into v_task_title from public.tasks where id = new.task_id;

  insert into public.notifications
    (user_id, type, title, message, task_id, extension_id, channel, dedupe_key)
  values (
    v_approver,
    'extension_requested',
    'Extension Requested',
    coalesce(v_requester_name, 'A team member') ||
      ' requested more time on "' || coalesce(v_task_title, 'a task') ||
      '". Reason: ' || new.reason,
    new.task_id,
    new.id,
    'both',
    'ext_req:' || new.id::text || ':' || v_approver::text
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing;

  return new;
end;
$$;

drop trigger if exists extension_requested on public.task_extensions;
create trigger extension_requested
  after insert on public.task_extensions
  for each row execute function public.tg_extension_requested();
