-- ============================================================================
-- 5LC TASK CONTROL - WHO GETS NOTIFIED ABOUT A TASK
--
-- THE RULE, IN ONE SENTENCE
-- ------------------------
--   A person is notified about a task ONLY IF they are the one it is assigned
--   to, or the one who assigned it.
--
--     notified(t)  <=>  t.assigned_to = me  OR  t.assigned_by = me
--
-- Nothing else earns a notification. Not seniority, not being in the same
-- department, not being in the reporting chain, not "they might want to
-- know". If you cannot name yourself as one of those two people on that row,
-- the notification is a bug.
--
-- WHY IT IS WRITTEN AS A QUERY
-- ----------------------------
-- Every claim in this file is checked by BLOCK E at the bottom, against the
-- real notifications table. A rule that cannot be falsified is a slogan, and
-- the previous two "is this duplication?" questions were both answered wrong
-- by reasoning about the code instead of reading the data. Run BLOCK E. If it
-- returns zero rows, the rule holds.
--
-- THE TWO PARTIES, NAMED
-- ----------------------
--   THE OWNER    = assigned_to   They do the work, so they get every status
--                                reminder. They do NOT get the completion
--                                notice - they caused it.
--   THE ASSIGNER = assigned_by   They handed the work out and are accountable
--                                for it finishing, so they get progress and
--                                completion.
--
-- Special case: when assigned_to = assigned_by (a personal, self-made task)
-- there is only ONE person and they get one notification, not two. That is
-- what the `is_personal_assignment()` branch in 0023 exists for, and why
-- `tg_tasks_after_update` guards the completion notice with
-- `assigned_by <> assigned_to`: you are not told that a task you just
-- finished yourself is now complete.
--
-- ---------------------------------------------------------------------------
-- WHAT EACH SENDER DOES TODAY  (read from migrations 0005 through 0029)
--
-- This table states the CURRENT rule status, so it was updated after 0029.
-- The status column distinguishes three things, which matters because they
-- need different actions:
--
--   YES      complies with the rule
--   FIXED    complied only after a later migration; the earlier sender is
--            named in the NOTE so the history is not lost
--   UNFIRED  would breach the rule, but has never actually run on this
--            database, so nothing has been sent. Left alone rather than
--            changed blind; see the section below.
-- ---------------------------------------------------------------------------
--
--   SENDER                     RECIPIENT            STATUS   NOTE
--   -------------------------  -------------------  -------  --------------
--   0025 pending_reminder      assigned_to          YES      AM only, by design
--   0025 due_today             assigned_to          YES      AM + PM
--   0025 due_today monitor     assigned_by/created  YES      dir only
--   0025 overdue               assigned_to          YES      AM + PM
--   0025 overdue monitor       assigned_by/created  YES      dir only
--   0029 task_completed        assigned_by          FIXED    was 0020, which
--                                                           also hit
--                                                           upline_chain()
--                                                           and every
--                                                           super_admin
--   0020 task_rejected         assigned_to          YES      only the doer
--   0010 reassignment notice   assigned_by          YES
--   0013 extension reviewed    task's assigned_by   YES
--   0022 monitor (5 triggers)  assigned_by/created  YES      dir only
--   0005 extension decided     assigned_by          YES
--   0025 escalation            manager/head/dir     UNFIRED  never run; see
--                                                           below
--   0014 extension_requested   requester's manager  UNFIRED  never run; see
--                                                           below
--
-- THE BREACH THAT WAS REAL, AND THE TWO THAT ARE NOT
-- --------------------------------------------------
-- Worth reading carefully, because the guess was wrong in both directions and
-- the audit is what corrected it.
--
--   FOUND AND FIXED - 0020 task_completed.
--     The obvious suspect (escalation) was innocent. The actual breach was the
--     completion notice: 0020 replaced 0010's tg_tasks_after_update, and
--     because both files `drop trigger if exists` then recreate it, the LATER
--     definition wins. So 0020's body was live, and it notified three groups:
--
--         select new.assigned_by                    -- the assigner    ok
--         union
--         select u.user_id from upline_chain(...)    -- managers above  NOT ok
--         union
--         select p.id from profiles where role =
--                'super_admin'                       -- every super_admin NOT ok
--
--     One super admin got one stray message per completion; with five super
--     admins it would fan out to all five on every task in the company.
--     0029 narrowed it to assigned_by alone.
--
--   NEVER FIRED - escalation and extension requests.
--     Both reach outside the two parties BY DESIGN, and both returned ZERO
--     rows in the audit: they have never run on this database. That is why
--     neither was changed. Retargeting code that has never executed would be
--     a guess dressed up as a fix.
--
--     IF EITHER STARTS FIRING it will breach the rule, block E above will say
--     so, and the fix is the same shape as 0029's - retarget to assigned_by:
--       * escalation (0025 block 3b) notifies the assignee's manager / head /
--         director. The assigner is the person who can actually chase it.
--       * extension_requested (0014) notifies the requester's manager. The
--         task's own assigned_by is the right approver.
--
-- ---------------------------------------------------------------------------
-- A NOTE ON THE SUPER_ADMIN RULE
-- ------------------------------
-- 0026's monitor selection (assigned_by / created_by, filtered to
-- director / super_admin) is COMPLIANT and must not be changed. The role
-- filter NARROWS the candidate set; it never widens it. That is the opposite
-- of the 0020 bug above, where super_admin was a UNION ARM that could only
-- ever ADD recipients. Same word, opposite effect - check which one you are
-- looking at before "fixing" it.
-- ---------------------------------------------------------------------------
--
-- STILL OPEN - A POLICY DECISION, NOT A BUG
-- -----------------------------------------
-- Escalation and extension requests are the only two senders that reach
-- outside the two parties, and neither has ever run. So there is nothing to
-- fix today; there is only a question:
--
--   Do you WANT overdue work to escalate up the chain, or only to the person
--   who assigned it?
--
-- If you want it up the chain, say so deliberately and treat the audit's
-- report on those two types as expected rather than as a failure. If you want
-- the rule enforced without exception, retarget both to assigned_by before
-- they first fire - see the note above for the exact shape.
--
-- Doing nothing is also a valid choice: they are not sending anything, so
-- they cannot annoy anyone. The risk of leaving them is simply that the first
-- escalation that ever fires will be a surprise.
-- ---------------------------------------------------------------------------


-- ============================================================================
-- BLOCK E  -  THE RULE CHECK  (run this first)
--
-- Returns one row PER VIOLATION. Zero rows = the rule holds for every
-- notification ever sent.
--
-- A violation is any notification whose recipient is neither assigned_to nor
-- assigned_by on the task it is attached to.
--
-- Nothing is filtered by date on purpose: this audits everything, not a spot
-- check of today. If old rows violate, the same rule was broken before and
-- you will want to know that too.
--
-- `is distinct from` is the NULL-safe comparison. `assigned_by` is nullable
-- (a self-made task may leave it null) and plain `<>` would return NULL for
-- those rows, silently dropping them from the audit - which is precisely the
-- population most likely to be mishandled.
-- ============================================================================

select
  n.id,
  n.type,
  n.created_at::date as sent_on,
  t.title,
  p.full_name as notified_person,
  p.role as their_role,
  t.assigned_to is not distinct from n.user_id as they_are_owner,
  t.assigned_by is not distinct from n.user_id as they_are_assigner,
  left(n.message, 60) as message
from public.notifications n
join public.tasks t on t.id = n.task_id
join public.profiles p on p.id = n.user_id
where n.user_id is distinct from t.assigned_to
  and n.user_id is distinct from t.assigned_by
order by n.created_at desc;


-- ============================================================================
-- BLOCK A  -  VIOLATIONS GROUPED BY TYPE
--
-- The same rule, counted. Read this to see WHERE the leaks are, not merely
-- that they exist.
--
-- Expect either zero rows, or only `escalation` and `extension_requested` -
-- the two senders documented above. Any OTHER type appearing here is a genuine
-- surprise and should be investigated before anything is changed.
-- ============================================================================

select
  n.type,
  count(*) as violations,
  min(n.created_at)::date as first_seen,
  max(n.created_at)::date as last_seen
from public.notifications n
join public.tasks t on t.id = n.task_id
where n.user_id is distinct from t.assigned_to
  and n.user_id is distinct from t.assigned_by
group by 1
order by 2 desc;


-- ============================================================================
-- BLOCK B  -  WHO IS BEING NOTIFIED, BY ROLE
--
-- The same violations from the other side: which roles are notified about
-- work that is not theirs. A row naming a `director` is the shape of the
-- escalation leak.
-- ============================================================================

select
  p.role as notified_role,
  n.type,
  count(*) as violations
from public.notifications n
join public.tasks t on t.id = n.task_id
join public.profiles p on p.id = n.user_id
where n.user_id is distinct from t.assigned_to
  and n.user_id is distinct from t.assigned_by
group by 1, 2
order by 3 desc;


-- ============================================================================
-- BLOCK C  -  THE COMPLIANT PATH, CONFIRMED
--
-- The complement of block E: every one of these IS a person who owns the task
-- or assigned it. The rule is genuinely being followed for the normal
-- reminders - not merely that violations are rare.
--
-- Expect several rows. `overdue` and `due_today` appearing twice per task is
-- correct: one AM row and one PM row, told apart by the `:am` / `:pm` suffix
-- on dedupe_key (0025).
-- ============================================================================

select
  n.type,
  count(*) as rows_sent,
  count(distinct n.user_id) as distinct_people
from public.notifications n
join public.tasks t on t.id = n.task_id
where n.user_id = t.assigned_to
   or n.user_id = t.assigned_by
group by 1
order by 2 desc;


-- ============================================================================
-- BLOCK D  -  IS ANYONE SELF-NOTIFIED TWICE?
--
-- A person notified about a task they neither run nor handed over is one
-- thing. Being notified twice about a task they BOTH own and assigned is
-- another - the personal-task case, which should produce exactly one row per
-- event and not two.
--
-- Expect NO rows. Any task listed with a count above 1 means the personal-task
-- guard has regressed.
-- ============================================================================

select
  n.type,
  t.title,
  count(*) as rows_to_owner_assigner
from public.notifications n
join public.tasks t on t.id = n.task_id
where t.assigned_to = t.assigned_by
  and n.user_id = t.assigned_to
  and n.created_at >= current_date
group by 1, 2
having count(*) > 1
order by 3 desc;


-- ============================================================================
-- END OF FILE - read-only. Nothing here writes, schedules or alters anything.
-- ============================================================================
