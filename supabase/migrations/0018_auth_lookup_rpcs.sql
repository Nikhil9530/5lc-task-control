-- ============================================================================
-- 5LC TASK CONTROL - 0018 AUTH LOOKUP RPCs
-- Employee ID -> company email, for the two screens that run with NO valid
-- session:
--   * get_login_email()           - used by the Sign In screen (index.tsx)
--   * get_password_reset_email()  - used by the Forgot Password screen
--
-- Why SECURITY DEFINER: profiles are readable only by signed-in users
-- (migration 0012, profiles_select = auth.role() = 'authenticated'), so a
-- signed-out screen can never read profiles.email on its own. Before this
-- function existed, Forgot Password always answered "Employee ID not found".
--
-- GRANTS: execute goes to `anon` because the caller is not authenticated yet.
-- Each function returns exactly ONE email address for ONE exact Employee ID -
-- never the rest of the profiles row. App-side rules (RLS, hierarchy checks)
-- are unaffected.
--
-- Note: the app already upper-cases the input, and upper(trim(...)) here makes
-- the lookup safe for any other caller too. Only ACTIVE employees resolve.
--
-- If the SQL Editor reports "cannot change return type of existing function",
-- a same-named function already exists with a different return type - drop it
-- first and re-run this file:
--   drop function if exists public.get_login_email(text);
--   drop function if exists public.get_password_reset_email(text);
-- ============================================================================

-- Sign In screen: resolve Employee ID -> email, then signInWithPassword()
create or replace function public.get_login_email(p_employee_id text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.email
  from public.profiles p
  where p.employee_id = upper(trim(p_employee_id))
    and p.is_active = true
  limit 1;
$$;

-- Forgot Password screen: resolve Employee ID -> email, then
-- auth.resetPasswordForEmail(email, { redirectTo: 'flctaskcontrol://reset' })
create or replace function public.get_password_reset_email(p_employee_id text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.email
  from public.profiles p
  where p.employee_id = upper(trim(p_employee_id))
    and p.is_active = true
  limit 1;
$$;

revoke all on function public.get_login_email(text) from public;
revoke all on function public.get_password_reset_email(text) from public;

grant execute on function public.get_login_email(text) to anon, authenticated;
grant execute on function public.get_password_reset_email(text) to anon, authenticated;
