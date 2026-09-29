/**
 * TASK CATEGORIES
 *
 * The task list is not one flat pile. Every task relates to the person looking
 * at it in one of three ways, and the three are mutually exclusive:
 *
 *   Mine            I raised it and it is sitting with me
 *   Assigned to me  somebody else handed it to me
 *   Assigned by me  I gave it to somebody else
 *
 * WHY THESE THREE
 * ---------------
 * They are the same three foreign keys the database already stores
 * (created_by / assigned_by / assigned_to) and the same three the 0023 RLS
 * policy branches on. Inventing a fourth category would mean a rule the
 * database does not share, and the two would eventually disagree.
 *
 * WHY "MINE" IS THE PERSONAL CASE ONLY
 * -----------------------------------
 * This is the subtle one, so it is worth stating plainly. "Mine" is NOT simply
 * "assigned to me" - otherwise the first two chips would show the same tasks
 * and the split would be pointless. It follows the server's own definition in
 * is_personal_assignment() (migration 0023):
 *
 *     assigned_to = coalesce(assigned_by, created_by)
 *
 * In words: I created it, and it came back to me. That is a self-made to-do,
 * which is genuinely different from work a manager or director handed me. An
 * ordinary task I was ASSIGNED therefore lands in "Assigned to me", not
 * "Mine" - and that is the whole point of the split.
 *
 * WHY THIS LIVES IN lib/ AND NOT IN THE SCREEN
 * --------------------------------------------
 * A file under app/ is an expo-router route and may only export its default
 * component, so the rule could not live in tasks.tsx and still be exported or
 * unit-tested. It also needs no React, which is what makes it testable at all.
 */

/** The three relational buckets, plus "all" meaning "no bucket filter". */
export type Category = 'mine' | 'assigned_to_me' | 'assigned_by_me' | 'all';

export const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'mine', label: 'Mine' },
  { key: 'assigned_to_me', label: 'Assigned to me' },
  { key: 'assigned_by_me', label: 'Assigned by me' },
  { key: 'all', label: 'All' },
];

/** Just the three uuids - the minimum needed to place a task. */
export type TaskKeys = {
  created_by: string | null;
  assigned_by: string | null;
  assigned_to: string | null;
};

/**
 * Is this task still OPEN, i.e. work somebody has to act on?
 *
 * The three relationship chips describe OPEN work only. A finished task is
 * still legitimately "assigned to me" - the relationship does not stop
 * existing when the job is done - but listing it under a chip whose whole
 * promise is "what is on my plate" buries today's work under yesterday's
 * completions.
 *
 * WHY THIS IS A SEPARATE PREDICATE RATHER THAN A BRANCH IN categoriseTask
 * ----------------------------------------------------------------------
 * Those are two independent questions and conflating them would make the
 * answer wrong in a way that is hard to see:
 *
 *   categoriseTask   WHOSE is this?      mine | assigned_to_me | assigned_by_me
 *   isOpen           IS IT STILL WORK?   true | false
 *
 * A completed task is still correctly "assigned to me"; it is just no longer
 * open. Keeping them apart means "All" can show finished work under its true
 * relationship while the three chips stay a to-do view.
 *
 * Plain "My Tasks" is a to-do list: it contains OPEN work only. Finished
 * work does not belong there at all - not under a chip, and not under "All"
 * either. Burying today's list under yesterday's completions is exactly the
 * complaint that produced this rule.
 *
 * The way back to finished work is the dashboard's "Completed Today" card,
 * which opens a KPI drill-down whose server bucket is completed rows.
 * (Completions older than today are not listable anywhere - that is the
 * accepted tradeoff, stated plainly so nobody rediscovers it later.)
 */
export function isOpenTask(task: { status: string }): boolean {
  return task.status !== 'completed';
}

/**
 * Which bucket does this task belong to, from `myId`'s point of view?
 *
 * Returns one of the three, or null when the task has no relationship to me.
 * The order of the checks IS the order of precedence, and that is what makes
 * the buckets exclusive: a self-assigned task is caught by the personal test
 * first, so it can never also be counted as "assigned to me" by the second
 * check. A task therefore lands in at most one bucket, and the three chip
 * counts sum to at most the total - the shortfall being the null rows, which
 * are reachable only on a company-wide read.
 *
 * WHY null AND NOT A THROW
 * ------------------------
 * An earlier version returned the string 'all' here, which was a lie: 'all' is
 * a filter meaning "no filter", and folding unclassified rows into it would
 * have made the per-chip counts quietly disagree with the list. null keeps the
 * three buckets honest, and "All" is defined as every row regardless.
 */
export function categoriseTask(
  task: TaskKeys,
  myId: string,
): Exclude<Category, 'all'> | null {
  const { created_by, assigned_by, assigned_to } = task;

  // Personal: I raised it AND it is sitting with me. The `??` matters - a task
  // created by me and assigned to me can carry assigned_by = null, and the
  // server coalesces to created_by in exactly that case.
  const isPersonal =
    !!assigned_to &&
    assigned_to === myId &&
    assigned_to === (assigned_by ?? created_by);

  if (isPersonal) return 'mine';

  // Sitting with me, but somebody else handed it over.
  if (assigned_to === myId) return 'assigned_to_me';

  // I gave it to somebody else. The created_by arm also catches a task I
  // created and delegated where assigned_by was left null.
  if (assigned_by === myId || created_by === myId) return 'assigned_by_me';

  // No relationship to me at all. Reachable only for a company-wide read
  // (Director/Super Admin see every row) where a task belongs to two other
  // people - e.g. one manager assigned work to another.
  //
  // null rather than a bucket, because inventing a fourth "other" category
  // would be wrong: the three chips describe MY relationship to a task, and
  // "neither of us" is not one of them. Such rows still appear under "All",
  // which is simply every row, so nothing becomes invisible.
  return null;
}

/**
 * Counts per category, for the numbers on the chips.
 *
 * 'all' is the row count, NOT the sum of the three. Those differ by the null
 * rows (a company-wide read where a task belongs to two other people), and
 * "All" genuinely does show every row - so defining it as the sum would make
 * the chip advertise a number the list would not deliver.
 */
export function countByCategory(
  tasks: TaskKeys[],
  myId: string,
): Record<Category, number> {
  const counts: Record<Category, number> = {
    mine: 0,
    assigned_to_me: 0,
    assigned_by_me: 0,
    all: tasks.length,
  };

  for (const task of tasks) {
    // Skip the null (unrelated) rows rather than letting them land in a
    // bucket they do not belong to.
    const bucket = categoriseTask(task, myId);

    if (bucket) counts[bucket] += 1;
  }

  return counts;
}
