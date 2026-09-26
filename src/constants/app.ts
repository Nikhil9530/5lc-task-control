// 5LC Task Control - shared brand + domain constants.
// Single source of truth so screens stay consistent and easy to theme.

export const COLORS = {
  navy: '#12233F',
  navySoft: '#344258',
  orange: '#E87516',
  orangeDark: '#D9630A',
  orangeSoft: '#FFF0E5',
  bg: '#F4F6F8',
  card: '#FFFFFF',
  border: '#E2E6EA',
  text: '#182337',
  textSoft: '#66717F',
  textFaint: '#9AA2AC',
  red: '#D64545',
  redSoft: '#FDEBEC',
  green: '#168653',
  greenSoft: '#E8F6EF',
  amber: '#D9A227',
  grey: '#8D98A5',
} as const;

export type Role = 'super_admin' | 'director' | 'head' | 'manager' | 'employee';

export type TaskStatus =
  | 'not_started'
  | 'in_progress'
  | 'waiting'
  | 'completed'
  | 'rejected';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export const STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  waiting: 'Waiting',
  completed: 'Completed',
  rejected: 'Rejected',
};

export const STATUS_COLORS: Record<TaskStatus, string> = {
  not_started: COLORS.grey,
  in_progress: COLORS.orange,
  waiting: COLORS.amber,
  completed: COLORS.green,
  rejected: COLORS.red,
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

// Extension delay reason categories (from the product blueprint).
export const EXTENSION_REASONS = [
  'Waiting for someone',
  'Waiting for quotation/vendor/customer',
  'Waiting for approval',
  'Waiting for information',
  'No resources',
  'Priority changed',
  'Employee unavailable',
  'Task more complicated than expected',
  'Other',
] as const;

export function formatStatusLabel(status: string): string {
  return status.replace(/_/g, ' ').toUpperCase();
}

// Safe colour lookup for a status string coming from the database.
export function statusColor(status: string): string {
  return STATUS_COLORS[status as TaskStatus] ?? COLORS.grey;
}

// ----------------------------------------------------------------------------
// Task workflow transitions - CLIENT MIRROR of migration 0020.
//
// The database is the authority: public.task_status_is_allowed() +
// tg_tasks_guard_update() will REJECT an illegal update. These helpers only
// keep the UI honest, so the app never offers a button that the server would
// refuse. If you change the SQL, change this too.
// ----------------------------------------------------------------------------

/** Forward-only: can a task move from `from` to `to`? */
export function isStatusTransitionAllowed(from: string, to: string): boolean {
  if (from === to) return true;

  switch (from) {
    case 'not_started':
      return ['in_progress', 'waiting', 'completed', 'rejected'].includes(to);
    case 'in_progress':
      return ['waiting', 'completed', 'rejected'].includes(to);
    // Work has already started, so it can never go back to not_started.
    case 'waiting':
      return ['in_progress', 'completed', 'rejected'].includes(to);
    // Reopening is a review decision, never a worker one.
    case 'completed':
      return to === 'in_progress';
    case 'rejected':
      return to === 'in_progress';
    default:
      return false;
  }
}

/**
 * Who the viewer is, relative to a task:
 *   doer     - the task is assigned to them (they report progress)
 *   reviewer - they assigned it, or they are above the assignee (approve/reject)
 *   admin    - director or super admin (full override)
 */
export type TaskActor = 'doer' | 'reviewer' | 'admin';

/** The statuses a given actor may actually set on a task currently in `from`. */
export function allowedNextStatuses(from: string, actor: TaskActor): TaskStatus[] {
  const candidates: TaskStatus[] = [
    'not_started',
    'in_progress',
    'waiting',
    'completed',
    'rejected',
  ];

  return candidates.filter((to) => {
    if (to === from) return false;
    if (!isStatusTransitionAllowed(from, to)) return false;

    if (actor === 'admin') return true;

    if (actor === 'doer') {
      // A completed task can only be reopened by a reviewer/admin.
      if (from === 'completed') return false;
      // Rejection is a review outcome, not something you do to yourself.
      return (['in_progress', 'waiting', 'completed'] as TaskStatus[]).includes(to);
    }

    // reviewer: may send back for rework, or reject. Never report progress.
    // A task that has not been picked up yet is off-limits - that was the
    // "I can edit the guy's task" complaint.
    if (from === 'not_started') return false;
    return (['in_progress', 'rejected'] as TaskStatus[]).includes(to);
  });
}

/** Human-readable label for a status value. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status as TaskStatus] ?? status.replace(/_/g, ' ');
}

