-- ============================================================================
-- 5LC TASK CONTROL - 0017 DELEGATION = MANAGERS AND ABOVE ONLY
--
-- Rule: Employees can create tasks for THEMSELVES (0016) but can NEVER
-- delegate - i.e. they cannot create delegated sub-tasks (parent_task_id)
-- for anyone, not even themselves. Only head / manager / director /
-- super_admin can delegate.
-- ============================================================================

drop policy if exists tasks_insert on public.tasks;

create policy tasks_insert on public.tasks for insert with check (
  -- normal assignment rules (self for employees, downline for managers, etc.)
  public.can_assign_to(assigned_to)
  and (
    -- a plain task is fine for everyone
    parent_task_id is null
    -- but a DELEGATED sub-task requires manager level or above
    or public.current_role() in ('super_admin', 'director', 'head', 'manager')
  )
);
