-- ============================================================================
-- 5LC TASK CONTROL - 0002 REMAINING TABLES (extensions, history, notifications, tokens)
-- ============================================================================

create table if not exists public.task_extensions (
  id                  uuid primary key default gen_random_uuid(),
  task_id             uuid not null references public.tasks (id) on delete cascade,
  requested_by        uuid references public.profiles (id) on delete set null,
  old_due_date        date,
  requested_due_date  date not null,
  reason              text not null,
  status              text not null default 'pending'
                        check (status in ('pending','approved','rejected')),
  reviewed_by         uuid references public.profiles (id) on delete set null,
  reviewed_at         timestamptz,
  review_comment      text,
  created_at          timestamptz not null default now()
);
create index if not exists task_extensions_task_idx   on public.task_extensions (task_id);
create index if not exists task_extensions_status_idx on public.task_extensions (status);

create table if not exists public.task_history (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks (id) on delete cascade,
  user_id     uuid references public.profiles (id) on delete set null,
  action      text not null,
  details     jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists task_history_task_idx on public.task_history (task_id);

create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  type         text not null,
  title        text not null,
  message      text not null,
  task_id      uuid references public.tasks (id) on delete cascade,
  extension_id uuid references public.task_extensions (id) on delete cascade,
  is_read      boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, is_read);

create table if not exists public.device_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  token       text not null,
  platform    text,
  device_name text,
  is_active   boolean not null default true,
  updated_at  timestamptz not null default now(),
  unique (user_id, token)
);
