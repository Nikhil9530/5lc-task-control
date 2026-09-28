-- ============================================================================
-- 5LC TASK CONTROL - VERIFY 0023 (DIRECT-ASSIGNMENT PERMISSIONS)
--
-- READ-ONLY. Nothing here writes data. Safe to run any time.
--
-- Run the three blocks in order in the Supabase SQL Editor and read the
-- output. Block B is the important one: it exercises the real
-- can_assign_to() function for every role pair instead of trusting the text
-- of the policy.
-- ============================================================================


-- ============================================================================
-- BLOCK A  -  IS THE POLICY SET ACTUALLY INSTALLED?
--
-- Expect 11 rows, each with the policy name and the table it guards.
-- ============================================================================

select
  tablename,
  policyname,
  cmd
from pg_policies
where schemaname = 'public'
  and policyname in (
    'profiles_select',
    'tasks_select',
    'tasks_update',
    'tasks_delete',
    'comments_select',
    'comments_insert',
    'extensions_select',
    'extensions_insert',
    'history_select',
    'history_insert',
    'recurring_select'
  )
order by tablename, policyname;


-- ============================================================================
-- BLOCK A2  -  IS is_self_or_downline() GONE FROM THE VISIBILITY POLICIES?
--
-- Expect ZERO rows. Any row here means a hierarchy decision survived in a
-- visibility policy and requirement D was not fully applied.
--
-- NOTE: it is expected and correct that tg_tasks_guard_update and
-- review_task_extension still reference is_self_or_downline - those are
-- WORKFLOW authority, which requirement 1 said to preserve.
-- ============================================================================

select
  tablename,
  policyname
from pg_policies
where schemaname = 'public'
  and coalesce(qual, '') || coalesce(with_check, '')
      like '%is_self_or_downline%';


-- ============================================================================
-- BLOCK B  -  FUNCTIONAL TEST OF THE FINAL ASSIGNMENT RULES
--
-- This sets the JWT subject per role and calls the REAL can_assign_to().
-- Y = allowed, N = blocked, - = no profile with that role exists yet.
--
-- EXPECTED
--   actor \ target   employee manager  head  director super_admin   self
--   employee             Y       Y       Y       N          N          Y
--   manager              Y       Y       Y       N          N          Y
--   head                 Y       Y       Y       N          N          Y
--   director             Y       Y       Y       Y          N          Y
--   super_admin          Y       Y       Y       Y          N          Y
--
-- The two deliberate asymmetries to look for:
--   * director -> director  is Y (a Director may assign to another Director)
--   * employee -> director  is N (only a Director may target a Director)
--   * super_admin as a target is ALWAYS N unless it is yourself
-- ============================================================================

do $$
declare
  v_roles  text[] := array[
    'employee', 'manager', 'head', 'director', 'super_admin'
  ];
  v_actor_id    uuid;
  v_target_id   uuid;
  v_actor_name  text;
  v_target_name text;
  v_line        text;
  v_self        text;
  v_flag        text;
begin
  foreach v_actor_name in array v_roles loop

    select id into v_actor_id
    from public.profiles
    where role = v_actor_name
    order by created_at
    limit 1;

    if v_actor_id is null then
      raise notice '%- : no profile with this role exists - skipped',
        v_actor_name;
      continue;
    end if;

    -- Act as this user for the rest of the loop body.
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', v_actor_id)::text,
      true
    );

    v_line := rpad(v_actor_name, 12) || ' -> ';

    foreach v_target_name in array v_roles loop

      select id into v_target_id
      from public.profiles
      where role = v_target_name
      order by created_at
      limit 1;

      if v_target_id is null then
        v_flag := '-';
      elsif public.can_assign_to(v_target_id) then
        v_flag := 'Y';
      else
        v_flag := 'N';
      end if;

      v_line := v_line || rpad(v_target_name, 12) || ':' || v_flag || '  ';
    end loop;

    if public.can_assign_to(v_actor_id) then
      v_self := 'Y';
    else
      v_self := 'N';
    end if;

    raise notice '%SELF:%', v_line, v_self;
  end loop;

  -- Leave no trace of the simulated login.
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ============================================================================
-- BLOCK C  -  PRIVACY PROOF
--
-- This one actually logs in AS different people (by setting the JWT subject
-- and switching to the `authenticated` role) and counts what each of them can
-- see. It is still read-only - it only runs SELECTs.
--
-- WHAT TO EXPECT
--   1) somebody else's PERSONAL task seen by a DIRECTOR       -> 0
--   2) an assigned task (A -> B) seen by ASSIGNEE B           -> 1
--   3) the same task seen by ASSIGNER A                       -> 1
--   4) the same task seen by a DIRECTOR who is not a party    -> 1
--   5) the same task seen by an unrelated EMPLOYEE            -> 0
--
-- If 1) is 1, personal-task privacy is NOT working.
-- If 4) is 0, Directors have lost their company-wide view.
-- ============================================================================

do $$
declare
  v_dir       uuid;
  v_emp       uuid;
  v_personal  uuid;
  v_assigned  uuid;
  v_assignee  uuid;
  v_assigner  uuid;
  v_n         int;
begin
  select id into v_dir
  from public.profiles where role = 'director'
  order by created_at limit 1;

  select id into v_emp
  from public.profiles where role = 'employee'
  order by created_at limit 1;

  if v_dir is null then
    raise notice 'SKIPPED - no director profile exists yet.';
    return;
  end if;

  -- ---- 1) Another person's personal task is invisible to a director. -----
  select t.id into v_personal
  from public.tasks t
  where public.is_personal_assignment(
          t.assigned_to, t.assigned_by, t.created_by)
    and t.assigned_to <> v_dir
  limit 1;

  if v_personal is null then
    raise notice '1) SKIPPED - no personal task owned by anyone else.';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_dir)::text, true);
    execute 'set local role authenticated';
    execute format(
      'select count(*) from public.tasks where id = %L', v_personal
    ) into v_n;
    execute 'reset role';
    raise notice '1) DIRECTOR sees another user''s personal task: % (expect 0)', v_n;
  end if;

  -- ---- 2-5) An assigned task and who can see it. -------------------------
  select t.id, t.assigned_to, t.assigned_by
  into v_assigned, v_assignee, v_assigner
  from public.tasks t
  where not public.is_personal_assignment(
              t.assigned_to, t.assigned_by, t.created_by)
  order by t.created_at
  limit 1;

  if v_assigned is null then
    raise notice '2) SKIPPED - no assigned (non-personal) task exists yet.';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_assignee)::text, true);
    execute 'set local role authenticated';
    execute format(
      'select count(*) from public.tasks where id = %L', v_assigned
    ) into v_n;
    execute 'reset role';
    raise notice '2) ASSIGNEE sees the assigned task: % row(s)  (expected 1)', v_n;

    if v_assigner is not null then
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_assigner)::text, true);
      execute 'set local role authenticated';
      execute format(
        'select count(*) from public.tasks where id = %L', v_assigned
      ) into v_n;
      execute 'reset role';
      raise notice '3) ASSIGNER sees the assigned task: % row(s)  (expected 1)', v_n;
    end if;

    perform set_config('request.jwt.claims',
      json_build_object('sub', v_dir)::text, true);
    execute 'set local role authenticated';
    execute format(
      'select count(*) from public.tasks where id = %L', v_assigned
    ) into v_n;
    execute 'reset role';
    raise notice '4) DIRECTOR sees the assigned task: % row(s)  (expected 1)', v_n;

    if v_emp is not null
       and v_emp <> v_assignee
       and v_emp <> v_assigner then
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_emp)::text, true);
      execute 'set local role authenticated';
      execute format(
        'select count(*) from public.tasks where id = %L', v_assigned
      ) into v_n;
      execute 'reset role';
      raise notice '5) UNRELATED EMPLOYEE sees the task: % (expect 0)', v_n;
    else
      raise notice '5) SKIPPED - no unrelated employee profile available.';
    end if;
  end if;

  perform set_config('request.jwt.claims', '', true);
end;
$$;
