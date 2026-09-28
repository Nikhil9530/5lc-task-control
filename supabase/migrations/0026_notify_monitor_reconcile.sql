-- ============================================================================
-- 5LC TASK CONTROL - 0026 RECONCILE notify_task_monitor WITH LIVE
--
-- WHY THIS EXISTS
-- ---------------
-- The function actually running in production did NOT match the file in
-- 0022. A pg_get_functiondef dump revealed three differences. Two of them are
-- IMPROVEMENTS that are being KEPT; one is a defect being FIXED.
--
--   #  0022 (repo)                     LIVE                    ACTION
--   -- ------------------------------  ----------------------  --------
--   1  monitor = coalesce(             monitor = UNION of     KEEP LIVE
--      assigned_by, created_by)        both, if either is a   (both can
--      -> at most ONE monitor          director/super_admin   monitor)
--   2  dedupe_key = coalesce(          dedupe_key =           KEEP LIVE
--      p_dedupe, 'mon:...')            coalesce(...)          (required by #1)
--                                                                          ||
--                                                             ':' || v_monitor
--   3  message uses '"'                message uses '""'      FIX -> '"'
--
-- WHY #2 MATTERS
-- --------------
-- With two monitors, both inserts would compute the SAME key. The second one
-- would then hit `on conflict (dedupe_key) ... do nothing` and vanish. So the
-- live version's `|| ':' || v_monitor` is not cosmetic - without it a second
-- monitoring Director would be silently dropped.
--
-- WHY #3 IS A BUG
-- ---------------
-- Inside a single-quoted SQL string, a double quote is an ordinary character,
-- so ' ""' emits TWO quote characters. Every monitor notification was reading:
--     Alice commented on ""Dispatch Report"" now in_progress
--
-- HOW TO RUN
-- ----------
-- Supabase -> SQL Editor, blocks 1 then 2.
-- ============================================================================


-- ============================================================================
-- BLOCK 1  -  THE CORRECTED FUNCTION
--
-- Same logic as production, with the doubled quotes removed.
-- ============================================================================

create or replace function public.notify_task_monitor(
  p_task_id uuid,
  p_event text,
  p_type text,
  p_title text,
  p_verb text,
  p_actor uuid default null,
  p_dedupe text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task    public.tasks%rowtype;
  v_monitor uuid;
  v_actor   text;
begin
  select * into v_task
  from public.tasks
  where id = p_task_id;

  if not found then
    return;
  end if;

  select full_name into v_actor
  from public.profiles
  where id = p_actor;

  -- Monitor = the Director / Super Admin who either assigned this task or
  -- created it. UNION semantics: if both are set and are different people,
  -- BOTH monitor it. Duplicates collapse via `select distinct`.
  for v_monitor in
    select distinct p.id
    from public.profiles p
    where p.role in ('director', 'super_admin')
      and p.id in (v_task.assigned_by, v_task.created_by)
  loop
    -- Never notify someone about their own action.
    if p_actor is not null and v_monitor = p_actor then
      continue;
    end if;

    insert into public.notifications (
      user_id, type, title, message, task_id, dedupe_key
    )
    values (
      v_monitor,
      p_type,
      p_title,
      coalesce(v_actor, 'Someone')
        || ' '
        || p_verb
        || ' "'
        || v_task.title
        || '" now '
        || replace(v_task.status, '_', ' '),
      p_task_id,
      -- The monitor id is appended OUTSIDE the coalesce on purpose: each
      -- monitor needs its own row, so their keys must differ.
      coalesce(
        p_dedupe,
        'mon:' || p_event || ':' || p_task_id::text
      ) || ':' || v_monitor::text
    )
    on conflict (dedupe_key) where dedupe_key is not null
    do nothing;
  end loop;
end;
$$;

-- INTERNAL ONLY. Every caller is a SECURITY DEFINER trigger or a cron
-- function, both of which run as the owner, so no grant is needed. Leaving
-- EXECUTE with `authenticated` would let any signed-in user push crafted
-- notifications to every monitoring Director.
revoke all on function public.notify_task_monitor(
  uuid, text, text, text, text, uuid, text
) from public, anon, authenticated;


-- ============================================================================
-- BLOCK 2  -  VERIFY
-- ============================================================================

-- 2a) The body should now show SINGLE double-quotes around the title:
--         || ' "'
--         || v_task.title
--         || '" now '
--     If you still see ' ""' or '"" now ', the old definition is running.
select pg_get_functiondef(
  'public.notify_task_monitor(uuid,text,text,text,text,uuid,text)'::regprocedure
);


-- 2b) Expect anon_can_execute = false and auth_can_execute = false.
select
  p.proname,
  has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as auth_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'notify_task_monitor';


-- ============================================================================
-- END OF 0026
--
-- WHAT THIS DID NOT CHANGE
--   * Monitor selection and the monitor-suffixed dedupe key are left exactly
--     as production already had them - they were correct, and 0022 in the repo
--     is now the one that was out of date. 0022 is applied history, so it is
--     not rewritten; this file is the correction.
--   * No trigger, policy or notification type is touched.
--   * No app change and no OTA - SQL only.
--
-- A NOTE ON THE THREE DRIFT INCIDENTS
--   notifications_type_check, the dashboard-named comment/history policies,
--   and now this function were all changed in the database without a
--   migration. The repo and the live database have diverged three times.
--   Whenever you change something in the SQL Editor, commit it here too -
--   otherwise the next person (or the next fresh environment) gets a
--   different system than the one you tested.
-- ============================================================================
