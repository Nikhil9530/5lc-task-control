-- ============================================================================
-- 5LC TASK CONTROL - 0024 DROP STALE HIERARCHY POLICIES
--
-- WHY THIS EXISTS
-- ---------------
-- 0023 replaced the hierarchy-based policies with direct-assignment ones.
-- Verification found that three OLD policies were never removed, because they
-- carry names that appear in NO migration - they were created directly in the
-- Supabase dashboard, so `drop policy if exists <my name>` never matched them.
--
-- Postgres ORs all PERMISSIVE policies together. So a stale policy silently
-- re-grants everything a new policy removed:
--
--   task_comments SELECT = task_comments_select (stale, hierarchy)
--                        OR comments_select      (new, participant-only)
--
-- This file closes exactly that gap. diagnostics/list_policies.sql predicted
-- this failure mode before it happened.
--
-- WHAT GETS DROPPED (3 policies, and nothing else)
--   task_comments.task_comments_select  -> hierarchy + "my own comments"
--   task_comments.task_comments_insert  -> downline may post comments
--   task_history.task_history_select    -> hierarchy + "my own history rows"
--
-- WHAT IS DELIBERATELY LEFT ALONE - READ THIS BEFORE ADDING DROPS
-- --------------------------------------------------------------
-- Several live policies have no counterpart in the repo, but they are
-- LOAD-BEARING and dropping them would break working features:
--
--   device_tokens  "Users can view their device tokens"
--                  "Users can register their device tokens"
--                  "Users can update their device tokens"
--                  "Users can delete their device tokens"
--        The repo's device_tokens_select / _upsert / _update do NOT exist in
--        this project. These four ARE the access control for device tokens.
--        Dropping them breaks push-notification registration.
--
--   notifications  "Users can view their notifications"
--                  "Users can mark their notifications read"
--                  "Users can delete their own notifications"
--        Same situation - notifications_select / _update do not exist, so
--        these are the only policies on the table.
--
--   task_extensions "Users can request task extensions"
--        Byte-identical rule to extensions_insert. A duplicate, not a hole.
--
--   profiles / system_settings
--        profiles_self_update, profiles_admin_all, settings_select and
--        settings_admin_write do not exist. That is NOT a problem today:
--        employee creation goes through the manage-user Edge Function using
--        the service role, which bypasses RLS, and the app never reads
--        system_settings (only SECURITY DEFINER functions do).
--        Left as-is so this migration changes no behaviour.
-- ============================================================================


-- ============================================================================
-- BLOCK 1  -  DROP THE THREE STALE POLICIES
-- ============================================================================

-- Comments: reading. The stale policy allowed the viewer's own comment rows
-- plus anyone in their downline. comments_select (0023) is the intended rule.
drop policy if exists task_comments_select on public.task_comments;

-- Comments: writing. The stale policy let downline POST comments on tasks
-- they are not part of. comments_insert (0023) requires participation.
drop policy if exists task_comments_insert on public.task_comments;

-- History: reading. Same shape as the comment select hole.
drop policy if exists task_history_select on public.task_history;


-- ============================================================================
-- BLOCK 2  -  VERIFY
--
-- Expect ZERO rows. Any row here is a policy that still references the
-- hierarchy in a visibility decision.
-- ============================================================================

select
  tablename,
  policyname,
  cmd
from pg_policies
where schemaname = 'public'
  and coalesce(qual, '') || coalesce(with_check, '')
      like '%is_self_or_downline%'
order by tablename, policyname;


-- ============================================================================
-- BLOCK 3  -  CONFIRM THE TABLES STILL HAVE EXACTLY THE INTENDED POLICIES
--
-- Expect 4 rows: one SELECT and one INSERT on each of task_comments and
-- task_history. If a SELECT or INSERT is missing, access is now too tight -
-- which is a bug in the opposite direction, so do not ignore it.
-- ============================================================================

select
  tablename,
  policyname,
  cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('task_comments', 'task_history')
order by tablename, cmd, policyname;
