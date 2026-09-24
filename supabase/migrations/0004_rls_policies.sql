-- ============================================================================
-- 5LC TASK CONTROL - 0004 ROW LEVEL SECURITY (the real authority)
-- Enable RLS on every table and define exactly who can see/do what.
-- NOTE: enabling RLS is idempotent; policies use drop+create for reruns.
-- ============================================================================

alter table public.profiles        enable row level security;
alter table public.tasks           enable row level security;
alter table public.task_comments   enable row level security;
alter table public.task_extensions enable row level security;
alter table public.task_history    enable row level security;
alter table public.notifications   enable row level security;
alter table public.device_tokens   enable row level security;

-- ---------------- PROFILES ----------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (
  auth.uid() = id
  or public.is_director_or_admin()
  or public.is_self_or_downline(id)
);

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles for all
  using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

-- ---------------- TASKS ----------------
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select using (
  assigned_to = auth.uid()
  or assigned_by = auth.uid()
  or created_by = auth.uid()
  or public.is_director_or_admin()
  or public.is_self_or_downline(assigned_to)
);

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert with check (
  public.can_assign_to(assigned_to)
);

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update using (
  assigned_to = auth.uid()
  or assigned_by = auth.uid()
  or public.is_director_or_admin()
  or public.is_self_or_downline(assigned_to)
);

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete using (
  public.is_director_or_admin() or assigned_by = auth.uid()
);

-- ---------------- TASK COMMENTS ----------------
drop policy if exists comments_select on public.task_comments;
create policy comments_select on public.task_comments for select using (
  exists (
    select 1 from public.tasks t
    where t.id = task_id and (
      t.assigned_to = auth.uid() or t.assigned_by = auth.uid()
      or public.is_director_or_admin() or public.is_self_or_downline(t.assigned_to)
    )
  )
);

drop policy if exists comments_insert on public.task_comments;
create policy comments_insert on public.task_comments for insert with check (
  user_id = auth.uid()
);

-- ---------------- TASK EXTENSIONS ----------------
drop policy if exists extensions_select on public.task_extensions;
create policy extensions_select on public.task_extensions for select using (
  requested_by = auth.uid()
  or public.is_director_or_admin()
  or exists (
    select 1 from public.tasks t
    where t.id = task_id and public.is_self_or_downline(t.assigned_to)
  )
);

drop policy if exists extensions_insert on public.task_extensions;
create policy extensions_insert on public.task_extensions for insert with check (
  requested_by = auth.uid()
);

-- updates (approve/reject) go ONLY through the review_task_extension() RPC,
-- which re-checks authority server-side. No direct client update policy.

-- ---------------- TASK HISTORY ----------------
drop policy if exists history_select on public.task_history;
create policy history_select on public.task_history for select using (
  exists (
    select 1 from public.tasks t
    where t.id = task_id and (
      t.assigned_to = auth.uid() or t.assigned_by = auth.uid()
      or public.is_director_or_admin() or public.is_self_or_downline(t.assigned_to)
    )
  )
);

drop policy if exists history_insert on public.task_history;
create policy history_insert on public.task_history for insert with check (
  user_id = auth.uid()
);
-- history is immutable: no update/delete policies.

-- ---------------- NOTIFICATIONS ----------------
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select using (
  user_id = auth.uid()
);

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- inserts come from server (service role / RPC), not directly from clients.

-- ---------------- DEVICE TOKENS ----------------
drop policy if exists device_tokens_select on public.device_tokens;
create policy device_tokens_select on public.device_tokens for select using (user_id = auth.uid());
drop policy if exists device_tokens_upsert on public.device_tokens;
create policy device_tokens_upsert on public.device_tokens for insert with check (user_id = auth.uid());
drop policy if exists device_tokens_update on public.device_tokens;
create policy device_tokens_update on public.device_tokens for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
