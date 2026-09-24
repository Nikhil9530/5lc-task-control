-- ============================================================================
-- 5LC TASK CONTROL - 0001 CORE SCHEMA
-- Captures the EXISTING live schema as code (versioned & recoverable).
-- IDEMPOTENT: safe to run on the existing project (uses IF NOT EXISTS).
-- Roles use a CHECK constraint (fixed set) instead of a roles table - leaner.
--   super_admin | director | head | manager | employee
-- ============================================================================

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  employee_id  text not null unique,
  full_name    text not null,
  email        text not null unique,
  role         text not null default 'employee'
                 check (role in ('super_admin','director','head','manager','employee')),
  department   text,
  manager_id   uuid references public.profiles (id) on delete set null,
  director_id  uuid references public.profiles (id) on delete set null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists profiles_manager_id_idx  on public.profiles (manager_id);
create index if not exists profiles_director_id_idx on public.profiles (director_id);
create index if not exists profiles_role_idx        on public.profiles (role);

create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  description     text,
  created_by      uuid references public.profiles (id) on delete set null,
  assigned_by     uuid references public.profiles (id) on delete set null,
  assigned_to     uuid references public.profiles (id) on delete cascade,
  department      text,
  priority        text not null default 'normal'
                    check (priority in ('low','normal','high','urgent')),
  start_date      date,
  due_date        date,
  status          text not null default 'not_started'
                    check (status in ('not_started','in_progress','waiting','completed','rejected')),
  parent_task_id  uuid references public.tasks (id) on delete set null,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists tasks_assigned_to_idx on public.tasks (assigned_to);
create index if not exists tasks_assigned_by_idx on public.tasks (assigned_by);
create index if not exists tasks_status_idx      on public.tasks (status);
create index if not exists tasks_due_date_idx    on public.tasks (due_date);
create index if not exists tasks_parent_task_idx on public.tasks (parent_task_id);

create table if not exists public.task_comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks (id) on delete cascade,
  user_id     uuid references public.profiles (id) on delete set null,
  comment     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists task_comments_task_idx on public.task_comments (task_id);
