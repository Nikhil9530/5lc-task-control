-- ============================================================================
-- 5LC TASK CONTROL - 0003 SECURITY HELPER FUNCTIONS
-- These enforce ROLE + HIERARCHY inside Postgres, so the APK is ONLY the UI.
-- Rule from blueprint: a user must NEVER gain Director power by editing the APK.
-- All are SECURITY DEFINER + STABLE so they can run inside RLS without recursion.
-- ============================================================================

-- Current user's role ('' if not logged in / no profile)
create or replace function public.current_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select coalesce((select role from public.profiles where id = auth.uid()), '');
$$;

-- Is the current user a Director or Super Admin? (company-wide authority)
create or replace function public.is_director_or_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('director','super_admin')
  );
$$;

-- Is `target` the current user, OR anywhere in the current user's downline?
-- Walks UP the manager chain from target; if it reaches current user -> true.
-- Depth-limited (50) so a bad manager_id cycle can never loop forever.
-- This is the single source of truth for "can I see/act on this person".
create or replace function public.is_self_or_downline(target uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  with recursive chain as (
    select p.id, p.manager_id, 1 as depth
    from public.profiles p
    where p.id = target
    union all
    select m.id, m.manager_id, c.depth + 1
    from public.profiles m
    join chain c on m.id = c.manager_id
    where c.depth < 50
  )
  select exists (select 1 from chain where id = auth.uid());
$$;

-- Can the current user create/assign a task to `target`?
-- director/super_admin -> anyone; head/manager -> downline only; employee -> nobody.
create or replace function public.can_assign_to(target uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.is_director_or_admin() then true
    when public.current_role() in ('head','manager')
         then public.is_self_or_downline(target) and target <> auth.uid()
    else false
  end;
$$;
