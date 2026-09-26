-- ============================================================================
-- 5LC TASK CONTROL - 0021 NOTIFICATION HYGIENE (read -> dismiss -> expire)
-- ============================================================================
--
-- WHY THIS EXISTS
-- ---------------
-- Users saw notifications from three days ago still sitting there forever.
-- That was TWO independent bugs, and this migration fixes the server half.
--
-- CLIENT HALF (lib/notificationCenter.ts, lib/useNotificationRouter.ts,
-- src/app/notifications.tsx):
--   Nothing in the app ever called dismissNotificationAsync() /
--   dismissAllNotificationsAsync(), and there was no tap listener at all.
--   So an Android tray entry stayed until the user manually swiped it, the
--   launcher badge never cleared, and tapping a push did nothing.
--
-- SERVER HALF (this file):
--   0004_rls_policies.sql created RLS policies for SELECT and UPDATE only.
--   With RLS enabled and NO DELETE policy, a signed-in user could never remove
--   their own notification rows. The table grew without bound and the inbox
--   replayed months-old rows on every single load.
--
-- Standard notification hygiene, applied here:
--   1. record WHEN the user acknowledged it (read_at)
--   2. let a user delete their OWN notifications (notifications_delete)
--   3. bulk-acknowledge in one round-trip (mark_notifications_read)
--   4. "Clear" button support (clear_read_notifications)
--   5. expire old rows so the table cannot grow forever (prune_notifications)
--
-- NOTE: nothing here deletes UNREAD work. An unread notification is an
-- unacknowledged obligation, so it is retained far longer than a read one
-- (90 days vs 30 days).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. read_at - the moment the user actually acknowledged the notification
-- ----------------------------------------------------------------------------
alter table public.notifications
  add column if not exists read_at timestamptz;

-- Keep read_at truthful regardless of which code path flips is_read
-- (the app, an RPC, or a server-side job). Doing it in a trigger means no
-- caller can forget.
create or replace function public.tg_notifications_set_read_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.is_read and not coalesce(old.is_read, false) then
    new.read_at := coalesce(new.read_at, now());
  elsif not new.is_read then
    new.read_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists tg_notifications_set_read_at on public.notifications;
create trigger tg_notifications_set_read_at
  before update on public.notifications
  for each row
  execute function public.tg_notifications_set_read_at();

-- Backfill: rows already flagged read need a timestamp so the retention job
-- can see them. created_at is the best available approximation.
update public.notifications
   set read_at = created_at
 where is_read
   and read_at is null;

-- Supports both the unread badge query and the retention sweep.
create index if not exists notifications_retention_idx
  on public.notifications (is_read, created_at);

-- ----------------------------------------------------------------------------
-- 2. DELETIONS - the missing policy that let notifications pile up forever
-- ----------------------------------------------------------------------------
-- A user may only ever delete their OWN notifications. The service role and
-- pg_cron are unaffected because they bypass RLS entirely.
drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications for delete
  using (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 3. mark_notifications_read - bulk acknowledge in ONE round-trip
-- ----------------------------------------------------------------------------
-- Pass an array of ids to acknowledge specific rows (this is what tapping a
-- push notification or an inbox row uses), or pass NULL / omit to acknowledge
-- everything ("Mark all read").
--
-- security invoker + an explicit user_id filter: RLS still applies, so this
-- can never touch another user's rows even if called with a forged id list.
create or replace function public.mark_notifications_read(
  p_ids uuid[] default null
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.notifications
     set is_read = true
   where user_id = auth.uid()
     and not is_read
     and (p_ids is null or id = any (p_ids));

  get diagnostics v_count = row_count;

  return v_count;
end;
$$;

revoke all on function public.mark_notifications_read(uuid[]) from public;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. clear_read_notifications - backs the inbox "Clear read" action
-- ----------------------------------------------------------------------------
-- Removes only rows the user has already acknowledged. Unread items are never
-- destroyed by this, so nothing actionable can be lost by a stray tap.
create or replace function public.clear_read_notifications()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.notifications
   where user_id = auth.uid()
     and is_read;

  get diagnostics v_count = row_count;

  return v_count;
end;
$$;

revoke all on function public.clear_read_notifications() from public;
grant execute on function public.clear_read_notifications() to authenticated;

-- ----------------------------------------------------------------------------
-- 5. RETENTION - stop unbounded growth
-- ----------------------------------------------------------------------------
-- Read rows are disposable after 30 days; unread rows are kept 90 days because
-- an unread notification is still an unacknowledged obligation.
--
-- security definer (it sweeps ALL users' rows, not just one) and NOT granted to
-- authenticated: this is a maintenance routine for cron / service_role only.
create or replace function public.prune_notifications(
  p_read_retain_days   integer default 30,
  p_unread_retain_days integer default 90
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.notifications
   where (
           is_read
           and created_at < now() - make_interval(days => p_read_retain_days)
         )
      or (
           not is_read
           and created_at < now() - make_interval(days => p_unread_retain_days)
         );

  get diagnostics v_count = row_count;

  return v_count;
end;
$$;

revoke all on function public.prune_notifications(integer, integer) from public;
revoke all on function public.prune_notifications(integer, integer) from authenticated;

-- ----------------------------------------------------------------------------
-- 6. SCHEDULE (Supabase pg_cron)
-- ----------------------------------------------------------------------------
-- Runs at 02:15 UTC (07:45 IST), clear of the 03:30 UTC daily checks and of
-- business hours. Wrapped so this file still applies cleanly on a project where
-- pg_cron is unavailable, matching the pattern already used in 0009.
do $$
begin
  create extension if not exists pg_cron;

  perform cron.unschedule('lc-prune-notifications')
    where exists (select 1 from cron.job where jobname = 'lc-prune-notifications');

  perform cron.schedule('lc-prune-notifications', '15 2 * * *',
    $job$ select public.prune_notifications(30, 90); $job$);

  raise notice 'Notification retention job scheduled.';
exception when others then
  raise notice 'pg_cron not available on this plan/project: %. Schedule public.prune_notifications(30, 90) with an external scheduler instead.', sqlerrm;
end;
$$;
