-- ============================================================================
-- 5LC TASK CONTROL - 0027 assignable_profiles()  (the one place that decides
--                                          who you may assign work to)
--
-- WHY THIS EXISTS
-- ---------------
-- create-task.tsx built its assignee list with a LOCAL hierarchy walk over
-- manager_id, and capped Employees at themselves:
--
--   director/super_admin -> everyone + self
--   head/manager         -> self + manager_id descendants   <- HIERARCHY
--   employee             -> self ONLY                       <- wrong
--
-- So Employee -> Employee was permitted by the database (0023) but
-- impossible in the app, and same-role assignment outside someone's own
-- reporting tree (Manager -> Head, Manager 2 -> Manager 2) was blocked too.
--
-- The alternative was to copy can_assign_to() into TypeScript. That puts the
-- rule in two places, and the next rule change would silently offer a target
-- the server then rejects. This RPC calls the SAME function that guards the
-- insert, so the picker can never disagree with the database.
--
-- Also fixes recurring.tsx, which listed every active profile without any
-- can_assign_to check - an Employee could pick a Director and get an RLS
-- error on save.
--
-- NOT an RLS bypass: it is `security invoker`, so it still runs under the
-- caller's read permissions on profiles.
--
-- HOW TO RUN
-- ----------
-- Supabase -> SQL Editor, blocks 1 and 2.
-- ============================================================================


-- ============================================================================
-- BLOCK 1  -  THE RPC
--
-- Returns self too: can_assign_to() allows self-assignment for every role,
-- so a personal task is on offer. Clients may label their own row "(me)".
-- ============================================================================

create or replace function public.assignable_profiles()
returns setof public.profiles
language sql
stable
set search_path = public
as $$
  select p.*
  from public.profiles p
  where p.is_active = true
    and public.can_assign_to(p.id)
  order by p.full_name;
$$;

comment on function public.assignable_profiles() is
  'Every active profile the caller may assign work to, computed by the same
can_assign_to() that guards tasks_insert. Removes hierarchy logic from the
client so the picker can never disagree with the database.';

-- Client-called, so it needs EXECUTE for signed-in users only.
revoke all on function public.assignable_profiles() from public, anon;
grant execute on function public.assignable_profiles() to authenticated;


-- ============================================================================
-- BLOCK 2  -  VERIFY
-- ============================================================================

-- 2a) The function exists and is locked to signed-in users.
--     Expect anon_can_execute = false, auth_can_execute = true.
select
  p.proname,
  has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'execute')
    as auth_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'assignable_profiles';


-- 2b) AS A DIRECTOR - expect every role present, because a Director may
--     assign to a Director or a Super Admin.
--
--     NOTE: running assignable_profiles() directly from the SQL Editor
--     returns ZERO rows. That is CORRECT, not a bug - there is no JWT in the
--     editor, so current_role() is '' and can_assign_to() fails closed. The
--     block below impersonates a real user inside one transaction and rolls
--     it back, so nothing is left behind.
--
--     If you see an error instead of a table, run `rollback;` first, then
--     paste me the message.
-- ============================================================================

begin;

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (select id from public.profiles
      where role = 'director'
      order by created_at limit 1)
  )::text,
  true
);

select role, count(*) as assignable_count
from public.assignable_profiles()
group by role
order by role;

rollback;


-- 2c) AS AN EMPLOYEE - expect employees ONLY (elevated targets are refused),
--     and this is the requirement that used to be impossible: Employee ->
--     Employee is now on offer instead of the picker showing self alone.
-- ============================================================================

begin;

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (select id from public.profiles
      where role = 'employee'
      order by created_at limit 1)
  )::text,
  true
);

select role, count(*) as assignable_count
from public.assignable_profiles()
group by role
order by role;

rollback;


-- ============================================================================
-- END OF 0027
--
-- WHAT THIS CHANGES IN THE APP
--   create-task.tsx : the manager_id tree walk (lines 97-137) is deleted and
--                     replaced by this RPC. Employee -> Employee, Manager ->
--                     Head and same-role assignment all become possible.
--   recurring.tsx   : the unfiltered profiles query (lines 65-71) is replaced
--                     by this RPC, so it can no longer offer a Director to an
--                     Employee.
--
-- No RLS change, no trigger change, no notification change. Client edits are
-- a JS-only OTA - no APK rebuild.
-- ============================================================================
