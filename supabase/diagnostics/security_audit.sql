-- ============================================================================
-- 5LC TASK CONTROL - SECURITY AUDIT
-- Run this in the Supabase SQL Editor anytime. It reports problems; it does
-- not change anything. Every section should return ZERO rows when secure.
-- ============================================================================

-- 1) Tables WITHOUT Row Level Security (any row here = anyone with the anon
--    key can read/write that table). Expected: empty.
select n.nspname as schema, c.relname as table_name, 'RLS DISABLED' as problem
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and n.nspname = 'public'
  and c.relrowsecurity = false
order by c.relname;

-- 2) Tables with RLS enabled but ZERO policies (any row here = nobody can
--    read anything - likely a forgotten policy). Expected: empty.
select c.relname as table_name, 'RLS ON BUT NO POLICIES' as problem
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and n.nspname = 'public'
  and c.relrowsecurity = true
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname
  )
order by c.relname;

-- 3) Permissive policies (qual = 'true') - these allow ANY authenticated user.
--    Review each: it is only acceptable where the data is intentionally
--    readable by all members (e.g. a company directory).
select tablename, policyname, cmd, qual
from pg_policies
where schemaname = 'public'
  and (qual = 'true' or qual is null)
order by tablename;

-- 4) SECURITY DEFINER functions WITHOUT a pinned search_path
--    (missing search_path = schema-hijacking attack surface). Expected: empty.
select p.proname as function_name, 'SECURITY DEFINER WITHOUT search_path' as problem
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef = true
  and not exists (
    select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%'
  )
order by p.proname;

-- 5) Dangerous grants to the anonymous role on tables (anon should get
--    almost nothing; RLS still applies, but least privilege is cleaner).
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee = 'anon'
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
order by table_name;

-- 6) Members marked active but with no hierarchy link (they would be invisible
--    to managers/directors for task assignment). Informational only.
select employee_id, full_name, role, department
from public.profiles
where is_active = true
  and role not in ('super_admin', 'director')
  and manager_id is null
  and director_id is null
order by role;

-- 7) Notification delivery failures (should be investigated when non-zero).
select type, count(*) as failed_count
from public.notifications
where delivery_status = 'failed'
group by type
order by failed_count desc;
