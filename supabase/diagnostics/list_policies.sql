-- ============================================================================
-- 5LC TASK CONTROL - DIAGNOSTIC: list existing RLS policies
-- RUN THIS IN THE SUPABASE SQL EDITOR **BEFORE** APPLYING 0003/0004.
--
-- WHY: Postgres ORs all permissive policies together. If old policies already
-- exist in your project (created in the dashboard), the new hardened policies
-- from 0004 would be ADDED to them - and any old permissive policy would still
-- let users through. Review this list and DROP anything too broad, e.g.:
--     drop policy "<name>" on public.<table>;
--
-- Look for: policies with `using (true)`, or missing role/hierarchy checks.
-- ============================================================================

select
  schemaname,
  tablename,
  policyname,
  cmd          as applies_to,
  permissive,
  roles,
  qual         as using_expression,
  with_check   as with_check_expression
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- Quick summary: how many policies each table has.
select tablename, count(*) as policy_count
from pg_policies
where schemaname = 'public'
group by tablename
order by tablename;
