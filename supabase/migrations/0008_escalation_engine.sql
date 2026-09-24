-- ============================================================================
-- 5LC TASK CONTROL - 0008 NOTIFICATION DELIVERY + ESCALATION ENGINE
-- ============================================================================

-- Delivery state + idempotency so cron cannot send the same reminder twice.
alter table public.notifications
  add column if not exists delivery_status text not null default 'pending'
    check (delivery_status in ('pending','sent','failed','skipped')),
  add column if not exists channel text not null default 'push'
    check (channel in ('push','email','both')),
  add column if not exists dedupe_key text,
  add column if not exists sent_at timestamptz;

create unique index if not exists notifications_dedupe_idx
  on public.notifications (dedupe_key) where dedupe_key is not null;

create index if not exists notifications_delivery_idx
  on public.notifications (delivery_status)
  where delivery_status = 'pending';

-- ----------------------------------------------------------------------------
-- Helper: who is above this user? (manager -> head -> director)
-- ----------------------------------------------------------------------------
create or replace function public.escalation_targets(p_user uuid)
returns table (level text, user_id uuid)
language sql stable security definer
set search_path = public
as $$
  with recursive chain as (
    select p.id, p.manager_id, p.director_id, 1 as depth
    from public.profiles p where p.id = p_user
    union all
    select m.id, m.manager_id, m.director_id, c.depth + 1
    from public.profiles m join chain c on m.id = c.manager_id
    where c.depth < 10
  )
  select 'manager'::text, id from chain where depth = 2
  union all
  select 'head'::text, id from chain where depth = 3
  union all
  select 'director'::text, id
  from chain where depth = (select max(depth) from chain) and depth > 3
  limit 3;
$$;

-- ----------------------------------------------------------------------------
-- Daily checks: morning reminder, due-today, overdue reminder, escalation.
-- Idempotent per day via dedupe_key. Safe to run repeatedly.
-- Called by pg_cron (or an Edge Function on a schedule).
-- ----------------------------------------------------------------------------
create or replace function public.run_daily_task_checks()
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  s              public.system_settings%rowtype;
  v_today        date;
  r              record;
  v_targets      text[];
  t              record;
begin
  select * into s from public.system_settings where id = 1;
  v_today := current_date;

  -- 1) DUE TODAY reminder -> assignee
  for r in
    select t.id, t.title, t.assigned_to
    from public.tasks t
    where t.status <> 'completed'
      and t.due_date = v_today
  loop
    insert into public.notifications (user_id, type, title, message, task_id, dedupe_key)
    values (r.assigned_to, 'due_today', 'Task Due Today',
            'Your task "' || r.title || '" is due today.', r.id,
            'due_today:' || r.id::text || ':' || v_today::text)
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end loop;

  -- 2) MORNING PENDING reminder -> assignee (open tasks not due today)
  for r in
    select t.id, t.title, t.assigned_to
    from public.tasks t
    where t.status <> 'completed'
      and (t.due_date is null or t.due_date <> v_today)
  loop
    insert into public.notifications (user_id, type, title, message, task_id, dedupe_key)
    values (r.assigned_to, 'pending_reminder', 'Pending Task Reminder',
            'Reminder: "' || r.title || '" is still pending.', r.id,
            'pending:' || r.id::text || ':' || v_today::text)
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end loop;

  -- 3) OVERDUE + ESCALATION
  for r in
    select t.id, t.title, t.assigned_to, t.due_date, t.priority,
           (v_today - t.due_date) as days_overdue
    from public.tasks t
    where t.status <> 'completed'
      and t.due_date is not null
      and t.due_date < v_today
  loop
    -- 3a) daily overdue reminder to the owner
    insert into public.notifications (user_id, type, title, message, task_id, dedupe_key)
    values (r.assigned_to, 'overdue', 'Task Overdue',
            '"' || r.title || '" is overdue by ' || r.days_overdue || ' day(s).',
            r.id, 'overdue:' || r.id::text || ':' || v_today::text)
    on conflict (dedupe_key) where dedupe_key is not null do nothing;

    -- 3b) escalation to the right level (urgent escalates faster)
    v_targets := array[]::text[];
    if r.priority = 'urgent' then
      if r.days_overdue >= s.urgent_escalate_day_director then v_targets := array['manager','head','director'];
      elsif r.days_overdue >= s.urgent_escalate_day_head then v_targets := array['manager','head'];
      else v_targets := array['manager']; end if;
    else
      if r.days_overdue >= s.escalate_day_director then v_targets := array['director'];
      elsif r.days_overdue >= s.escalate_day_head then v_targets := array['head'];
      elsif r.days_overdue >= s.escalate_day_manager then v_targets := array['manager'];
      end if;
    end if;

    if array_length(v_targets, 1) is not null then
      for t in select * from public.escalation_targets(r.assigned_to)
      loop
        if t.level = any(v_targets) then
          insert into public.notifications (user_id, type, title, message, task_id, dedupe_key)
          values (t.user_id, 'escalation', 'Escalation: Overdue Task',
                  'Task "' || r.title || '" is overdue by ' || r.days_overdue ||
                  ' day(s) and needs attention.',
                  r.id, 'esc:' || t.level || ':' || r.id::text || ':' || v_today::text)
          on conflict (dedupe_key) where dedupe_key is not null do nothing;
        end if;
      end loop;
    end if;
  end loop;
end;
$$;

revoke all on function public.run_daily_task_checks() from public;
