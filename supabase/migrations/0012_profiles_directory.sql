-- ============================================================================
-- 5LC TASK CONTROL - 0012 PROFILES = COMPANY DIRECTORY (READ-ONLY)
--
-- Why: comments, task history, notifications and assignee pickers all need to
-- display NAMES of colleagues. With the original per-hierarchy SELECT policy,
-- an employee could not see their manager's name, so those screens would show
-- blank/UUID values.
--
-- Decision: every authenticated member may READ the directory
-- (id, name, employee_id, email, role, department, hierarchy ids).
-- This is normal for an internal company directory.
--
-- WRITES stay locked down (unchanged from 0004):
--   - self may update own profile
--   - super_admin may do everything
--   - creating/updating OTHER members goes through the manage-user
--     Edge Function only (service role, role-verified server-side)
--
-- No sensitive data lives in profiles: passwords are in auth.users (managed by
-- Supabase Auth, never exposed) and device tokens are in device_tokens (per-user).
-- ============================================================================

drop policy if exists profiles_select on public.profiles;

create policy profiles_select on public.profiles for select
  using (auth.role() = 'authenticated');

-- Extra safety: never let anyone but the owner change their own password or
-- see other users' device tokens. (device_tokens RLS is already per-user in
-- 0004; this is just documentation of intent.)
