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
