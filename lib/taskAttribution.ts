/**
 * TASK ATTRIBUTION
 *
 * Every task carries three foreign keys into `profiles`:
 *
 *   created_by  - who raised the task
 *   assigned_by - who handed the work out (survives reassignment)
 *   assigned_to - who currently owns it
 *
 * The screen shows NAMES, never the uuids. The uuids stay in the database
 * because they are the relationships; the names arrive as three EMBEDDED
 * profile objects on the task row itself, so attribution costs no extra
 * round-trip.
 *
 * WHY THE `!created_by` STYLE HINTS ARE MANDATORY
 * ----------------------------------------------
 * `tasks` has three separate foreign keys onto the SAME table (`profiles`).
 * PostgREST cannot tell them apart, so a bare `profiles(full_name)` inside a
 * tasks select is an ambiguous embed and the request fails with PGRST200.
 * Naming the column (`profiles!assigned_to(...)`) pins each embed to one key.
 * The three aliases below are also distinct, because a repeated alias in one
 * select is rejected too.
 *
 * This is a plain client-side read. It is NOT an RLS bypass - each embedded
 * row is still filtered by `profiles_select`, so a viewer never sees a name
 * the directory policy would not already let them read.
 */

/** The slice of `profiles` the three joins return. */
export type PersonRef = {
  id: string;
  full_name: string;
  employee_id: string | null;
};

/** The three attribution fields as they come back on a task row. */
export type TaskAttribution = {
  created_by: string | null;
  assigned_by: string | null;
  assigned_to: string | null;
  creator: PersonRef | null;
  assigner: PersonRef | null;
  assignee: PersonRef | null;
};

/**
 * THE SELECT FRAGMENT (documentation, not a constant)
 * --------------------------------------------------
 * Every task query on this screen that wants attribution must include all six
 * of these - three keys and three embeds:
 *
 *   created_by, assigned_by, assigned_to,
 *   creator:profiles!created_by(id, full_name, employee_id),
 *   assigner:profiles!assigned_by(id, full_name, employee_id),
 *   assignee:profiles!assigned_to(id, full_name, employee_id)
 *
 * It is written out as a LITERAL STRING at each call site rather than exported
 * as one shared constant. That is deliberate: supabase-js infers the result
 * row type by parsing the select string, and a value built by interpolation
 * (`\`...${CONST}\``) is opaque to that parser, so the result silently degrades
 * and every setState against it fails to typecheck. The duplication is the
 * price of the type inference, and this block is the contract to diff against.
 *
 * The three `!<column>` hints are mandatory. `tasks` has three separate foreign
 * keys onto the SAME table, so a bare `profiles(...)` is an ambiguous embed and
 * PostgREST rejects it with PGRST200. The three aliases must be distinct too -
 * a repeated alias in one select is also rejected.
 *
 * This is a plain client-side read. It is NOT an RLS bypass - each embedded
 * row is still filtered by `profiles_select`, so a viewer never sees a name
 * the directory policy would not already let them read.
 */

/**
 * Normalise one embedded profile into a PersonRef, or null.
 *
 * WHY THIS EXISTS
 * ---------------
 * PostgREST returns a to-one embed as a single OBJECT, and that is what the
 * three joins produce at runtime. But this project's supabase client is
 * created without a generated `Database` generic (see lib/supabase.ts), so
 * supabase-js has no relationship metadata and types every embed as an ARRAY.
 * Left alone, that mismatch makes the row untypeable at every setState.
 *
 * Rather than sprinkle `as unknown as Task` at the four call sites - which
 * silences far more than the embed and would hide a genuine shape change - the
 * narrowing happens here, once, and is deliberately total: it accepts either
 * shape and returns null for anything that is not a person row. A dropped
 * attribution line is a cosmetic bug; a screen that renders `undefined` or
 * crashes on a missing profile is not.
 */
export function asPersonRef(value: unknown): PersonRef | null {
  if (!value || typeof value !== 'object') return null;

  // An array embed (what the untyped client claims) - take the first entry.
  // `!hint` on a many-to-one is always zero or one row, so this cannot pick
  // the wrong person; it only papers over the missing type metadata.
  const row = (Array.isArray(value) ? value[0] : value) as
    | Partial<PersonRef>
    | undefined
    | null;

  if (!row || typeof row.id !== 'string') return null;

  return {
    id: row.id,
    full_name: typeof row.full_name === 'string' ? row.full_name : '',
    employee_id:
      typeof row.employee_id === 'string' ? row.employee_id : null,
  };
}

/**
 * Pin the three embeds on a fetched task row to PersonRef | null.
 *
 * The input is deliberately loose (`Embeds = unknown`): the value coming out
 * of the client is statically an array, which does NOT satisfy
 * `TaskAttribution`. Constraining to that would force a cast at the call site
 * and defeat the point. Only the three embed fields are narrowed here; every
 * other column passes through untouched.
 *
 * Spread through so the task keeps every other selected column:
 *   setTasks(rows.map(withAttribution))
 */
export function withAttribution<
  T extends { creator: unknown; assigner: unknown; assignee: unknown },
>(row: T): Omit<T, 'creator' | 'assigner' | 'assignee'> & {
  creator: PersonRef | null;
  assigner: PersonRef | null;
  assignee: PersonRef | null;
} {
  return {
    ...row,
    creator: asPersonRef(row.creator),
    assigner: asPersonRef(row.assigner),
    assignee: asPersonRef(row.assignee),
  };
}

/**
 * Best available label for a person, or null when there is nobody to name.
 *
 * Falls back to the employee code only when full_name is empty, and returns
 * null - never 'undefined' or a uuid - when the profile row is missing
 * (deactivated account, or RLS withheld the row).
 */
export function personName(person?: PersonRef | null): string | null {
  if (!person) return null;
  return person.full_name || person.employee_id || null;
}

/** "Ava Rao (EMP014)" - the form used on the reporting screens. */
export function personLabel(person?: PersonRef | null): string | null {
  const name = personName(person);

  if (!name) return null;

  return person?.employee_id ? `${name} (${person.employee_id})` : name;
}

/**
 * The three display lines, in a fixed order, with any blank one dropped.
 * Returning rows (rather than three nullable strings) is what lets a card
 * render `map` instead of three near-identical blocks, and guarantees a
 * self-assigned task does not print "Assigned By: Same person" twice.
 */
export function attributionRows(
  task: Partial<TaskAttribution> | null | undefined,
): { label: string; value: string }[] {
  if (!task) return [];

  const rows: { label: string; value: string | null }[] = [
    { label: 'CREATED BY', value: personLabel(task.creator) },
    { label: 'ASSIGNED BY', value: personLabel(task.assigner) },
    { label: 'ASSIGNED TO', value: personLabel(task.assignee) },
  ];

  return rows.filter(
    (r): r is { label: string; value: string } => !!r.value,
  );
}
