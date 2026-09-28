-- ============================================================================
-- 5LC TASK CONTROL - VERIFY DIRECT-ASSIGNMENT PERMISSIONS (ROW-RETURNING)
--
-- READ-ONLY. Every block here only SELECTs.
--
-- WHY THIS VERSION EXISTS
-- -----------------------
-- The first verification script used RAISE NOTICE, which the Supabase SQL
-- Editor does NOT display - it just reports "Success. No rows returned".
-- Everything here RETURNS ROWS instead, so the results are visible.
--
-- Blocks B and C need a tiny test harness (a function). Creating it is the
-- only write in this file, and Block Z removes it again afterwards. The
-- harness functions themselves change no data.
--
-- Run in order: A, A2, A3, B, B2, B3, C, C2.
-- ============================================================================


-- ============================================================================
-- BLOCK A  -  THE 0023 POLICY SET IS INSTALLED?
-- Expect 11 rows.
-- ============================================================================

select
  tablename,
  policyname,
  cmd
from pg_policies
where schemaname = 'public'
  and policyname in (
    'profiles_select',
    'tasks_select',
    'tasks_update',
    'tasks_delete',
    'comments_select',
    'comments_insert',
    'extensions_select',
    'extensions_insert',
    'history_select',
    'history_insert',
    'recurring_select'
  )
order by tablename, policyname;


-- ============================================================================
-- BLOCK A2  -  HIERARCHY SURVIVORS IN VISIBILITY POLICIES
--
-- Expect ZERO rows. A row means a hierarchy decision is still active in some
-- policy - and because Postgres ORs permissive policies together, a stale
-- policy silently re-grants everything the new one removed.
-- ============================================================================

select
  tablename,
  policyname,
  cmd,
  coalesce(qual, '') as using_expr
from pg_policies
where schemaname = 'public'
  and coalesce(qual, '') || coalesce(with_check, '')
      like '%is_self_or_downline%'
order by tablename, policyname;


-- ============================================================================
-- BLOCK A3  -  COMPLETE POLICY INVENTORY  (the drift check)
--
-- This is every policy in the public schema, with its definition. Compare it
-- against the list below, which is every policy the repository migrations
-- create:
--
--   profiles          profiles_select, profiles_self_update,
--                     profiles_admin_all
--   tasks             tasks_select, tasks_insert, tasks_update,
--                     tasks_delete
--   task_comments     comments_select, comments_insert
--   task_extensions   extensions_select, extensions_insert
--   task_history      history_select, history_insert
--   notifications     notifications_select, notifications_update,
--                     notifications_delete
--   device_tokens     device_tokens_select, device_tokens_upsert,
--                     device_tokens_update
--   system_settings   settings_select, settings_admin_write
--   recurring_tasks   recurring_select, recurring_write
--
-- ANY OTHER NAME IS UNDOCUMENTED DRIFT and needs a decision - most likely it
-- is an older policy still granting access the new model removed.
-- ============================================================================

select
  tablename,
  policyname,
  cmd,
  roles::text as roles,
  coalesce(qual, '-') as using_expr,
  coalesce(with_check, '-') as check_expr
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- ============================================================================
-- BLOCK B  -  TEST HARNESS for can_assign_to()
--
-- can_assign_to() decides the actor from auth.uid(), which comes from the JWT.
-- This wrapper pretends to be a given actor for one call only, then restores
-- whatever was there before. It changes no data.
-- ============================================================================

create or replace function public.diag_can_assign(
  p_actor uuid,
  p_target uuid
)
returns boolean
language plpgsql
volatile
as $$
declare
  v_prev text := current_setting('request.jwt.claims', true);
  v_out  boolean;
begin
  if p_actor is null or p_target is null then
    return null;
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_actor)::text,
    true
  );

  v_out := public.can_assign_to(p_target);

  perform set_config(
    'request.jwt.claims',
    coalesce(v_prev, ''),
    true
  );

  return v_out;
end;
$$;

revoke all on function public.diag_can_assign(uuid, uuid) from public;
grant execute on function public.diag_can_assign(uuid, uuid) to authenticated;


-- ============================================================================
-- BLOCK B2  -  THE ASSIGNMENT MATRIX  (25 rows, one per actor/target pair)
--
-- EXPECTED
--   actor \ target   employee manager  head  director super_admin
--   employee             Y       Y       Y       N          N
--   manager              Y       Y       Y       N          N
--   head                 Y       Y       Y       N          N
--   director             Y       Y       Y       Y          Y
--   super_admin          Y       Y       Y       Y          Y
--
-- An ELEVATED target (Director or Super Admin) may only be targeted by a
-- Director or a Super Admin. Everyone else is open to any signed-in user.
--
-- '-' means no profile with that role exists yet.
-- The 'verdict' column tells you immediately whether each cell is right.
-- ============================================================================

with roles(ord, role_name) as (
  values
    (1, 'employee'),
    (2, 'manager'),
    (3, 'head'),
    (4, 'director'),
    (5, 'super_admin')
),
actors as (
  select r.ord, r.role_name,
         (select p.id from public.profiles p
           where p.role = r.role_name
           order by p.created_at limit 1) as actor_id
  from roles r
),
targets as (
  select r.ord, r.role_name,
         (select p.id from public.profiles p
           where p.role = r.role_name
           order by p.created_at limit 1) as target_id
  from roles r
),
matrix as (
  select
    a.role_name as actor,
    t.role_name as target,
    public.diag_can_assign(a.actor_id, t.target_id) as allowed
  from actors a, targets t
  order by a.ord, t.ord
),
expected(actor, target, want) as (
  values
    ('employee',    'employee',    true),
    ('employee',    'manager',     true),
    ('employee',    'head',        true),
    ('employee',    'director',    false),
    ('employee',    'super_admin', false),
    ('manager',     'employee',    true),
    ('manager',     'manager',     true),
    ('manager',     'head',        true),
    ('manager',     'director',    false),
    ('manager',     'super_admin', false),
    ('head',        'employee',    true),
    ('head',        'manager',     true),
    ('head',        'head',        true),
    ('head',        'director',    false),
    ('head',        'super_admin', false),
    ('director',    'employee',    true),
    ('director',    'manager',     true),
    ('director',    'head',        true),
    ('director',    'director',    true),
    ('director',    'super_admin', true),
    ('super_admin', 'employee',    true),
    ('super_admin', 'manager',     true),
    ('super_admin', 'head',        true),
    ('super_admin', 'director',    true),
    ('super_admin', 'super_admin', true)
)
select
  m.actor,
  m.target,
  case
    when m.allowed is null then '-'
    when m.allowed then 'Y'
    else 'N'
  end as allowed,
  case
    when m.allowed is null then 'n/a'
    when m.allowed = e.want then 'PASS'
    else 'FAIL'
  end as verdict
from matrix m
left join expected e
  on e.actor = m.actor and e.target = m.target
order by m.actor, m.target;

-- ============================================================================
-- BLOCK B3  -  SELF-ASSIGNMENT (the personal-task case)
-- Expect Y / PASS for EVERY role, including super_admin.
-- ============================================================================

with roles(ord, role_name) as (
  values
    (1, 'employee'),
    (2, 'manager'),
    (3, 'head'),
    (4, 'director'),
    (5, 'super_admin')
),
me as (
  select r.ord, r.role_name,
         (select p.id from public.profiles p
           where p.role = r.role_name
           order by p.created_at limit 1) as id
  from roles r
)
select
  role_name as role,
  case
    when id is null then '-'
    when public.diag_can_assign(id, id) then 'Y'
    else 'N'
  end as self_assign,
  case
    when id is null then 'n/a'
    when public.diag_can_assign(id, id) then 'PASS'
    else 'FAIL'
  end as verdict
from me
order by ord;


-- ============================================================================
-- BLOCK C  -  TEST HARNESS for row visibility
--
-- This one becomes a normal signed-in user (SET LOCAL ROLE authenticated) and
-- counts how many rows that user can actually see. Without switching role the
-- superuser would bypass RLS and every count would be 1.
-- ============================================================================

create or replace function public.diag_visible(
  p_viewer uuid,
  p_task uuid
)
returns int
language plpgsql
volatile
as $$
declare
  v_prev text := current_setting('request.jwt.claims', true);
  v_n    int;
begin
  if p_viewer is null or p_task is null then
    return null;
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_viewer)::text,
    true
  );

  -- As the superuser RLS is bypassed, so switch to a real signed-in role.
  set local role authenticated;

  select count(*) into v_n
  from public.tasks t
  where t.id = p_task;

  reset role;

  perform set_config(
    'request.jwt.claims',
    coalesce(v_prev, ''),
    true
  );

  return v_n;
end;
$$;

revoke all on function public.diag_visible(uuid, uuid) from public;
grant execute on function public.diag_visible(uuid, uuid) to authenticated;

-- ============================================================================
-- BLOCK C2  -  PRIVACY PROBE  (5 rows)
--
-- EXPECTED
--   1) DIRECTOR sees another user's PERSONAL task      -> visible 0
--   2) ASSIGNEE sees the assigned task                 -> visible 1
--   3) ASSIGNER sees the assigned task                 -> visible 1
--   4) DIRECTOR (not a party) sees the assigned task   -> visible 1
--   5) UNRELATED EMPLOYEE sees the assigned task       -> visible 0
--
-- 'n/a' means the test could not run - usually because there is no personal
-- task owned by somebody other than the first director, or no assigned
-- (non-personal) task, or no unrelated employee. Create one of each and re-run.
--
-- If row 1 shows 1, personal-task privacy is NOT working - and check Block A2,
-- because a stale policy is the most likely reason.
-- ============================================================================

with subj as (
  select
    (select p.id from public.profiles p
      where p.role = 'director'
      order by p.created_at limit 1) as dir
),
personal_task as (
  select t.id
  from public.tasks t
  where public.is_personal_assignment(
          t.assigned_to, t.assigned_by, t.created_by)
    and t.assigned_to is distinct from (select dir from subj)
  limit 1
),
assigned_task as (
  select t.id, t.assigned_to, t.assigned_by
  from public.tasks t
  where not public.is_personal_assignment(
              t.assigned_to, t.assigned_by, t.created_by)
  order by t.created_at
  limit 1
),
probe as (
  select
    1 as ord,
    '1) DIRECTOR sees another user''s PERSONAL task' as scenario,
    public.diag_visible(
      (select dir from subj),
      (select id from personal_task)
    ) as visible,
    0 as expected

  union all

  select
    2,
    '2) ASSIGNEE sees the assigned task',
    public.diag_visible(
      (select assigned_to from assigned_task),
      (select id from assigned_task)
    ),
    1

  union all

  select
    3,
    '3) ASSIGNER sees the assigned task',
    public.diag_visible(
      (select assigned_by from assigned_task),
      (select id from assigned_task)
    ),
    1

  union all

  select
    4,
    '4) DIRECTOR (not a party) sees the assigned task',
    public.diag_visible(
      (select p.id from public.profiles p
        where p.role in ('director', 'super_admin')
          and p.id is distinct from
              (select assigned_to from assigned_task)
          and p.id is distinct from
              (select assigned_by from assigned_task)
        order by p.created_at limit 1),
      (select id from assigned_task)
    ),
    1

  union all

  select
    5,
    '5) UNRELATED EMPLOYEE sees the assigned task',
    public.diag_visible(
      (select p.id from public.profiles p
        where p.role = 'employee'
          and p.id is distinct from
              (select assigned_to from assigned_task)
          and p.id is distinct from
              (select assigned_by from assigned_task)
        order by p.created_at limit 1),
      (select id from assigned_task)
    ),
    0
)
select
  scenario,
  visible,
  expected,
  case
    when visible is null then 'n/a'
    when visible = expected then 'PASS'
    else 'FAIL'
  end as verdict
from probe
order by ord;


-- ============================================================================
-- BLOCK Z  -  REMOVE THE TEST HARNESS
--
-- Optional, but tidy. Run it after you have read the results of B2, B3 and C2.
-- Re-running blocks B and C recreates the harness if you need it again.
-- ============================================================================

drop function if exists public.diag_can_assign(uuid, uuid);
drop function if exists public.diag_visible(uuid, uuid);
