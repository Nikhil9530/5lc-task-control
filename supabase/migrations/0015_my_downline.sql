-- ============================================================================
-- 5LC TASK CONTROL - 0015 my_downline()
-- Returns the ids of everyone BELOW the current user in the reporting chain.
--
-- Why: profiles are now readable as a company directory (migration 0012) so
-- that names show up in comments/history/notifications. The "My Team" screen
-- must still show ONLY the current user's downline - this function gives the
-- app the correct ids server-side (no client-side trust).
-- ============================================================================

create or replace function public.my_downline()
returns table (member_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with recursive down as (
    select p.id, 1 as depth
    from public.profiles p
    where p.manager_id = auth.uid()
    union
    select p.id, d.depth + 1
    from public.profiles p
    join down d on p.manager_id = d.id
    where d.depth < 50
  )
  select id from down;
$$;

revoke all on function public.my_downline() from public;
grant execute on function public.my_downline() to authenticated;
