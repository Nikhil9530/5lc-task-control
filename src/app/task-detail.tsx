import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { goBack, nav } from '../../lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { supabase } from '../../lib/supabase';
import { getMyId, getSessionProfile } from '../../lib/auth';
import { AppPress, Skeleton } from '../../lib/ui';
import { COLORS, EXTENSION_REASONS, statusColor, allowedNextStatuses, type TaskActor } from '../constants/app';
import {
  attributionRows,
  withAttribution,
  type PersonRef,
} from '../../lib/taskAttribution';

type TaskStatus =
  | 'not_started'
  | 'in_progress'
  | 'waiting'
  | 'completed'
  | 'rejected';

type Task = {
  id: string;
  title: string;
  description: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: TaskStatus;
  due_date: string | null;
  start_date: string | null;
  created_at: string;
  completed_at: string | null;
  parent_task_id: string | null;
  // Needed to decide WHO may drive the status (see migration 0020):
  // the assignee reports progress, everyone above them reviews.
  assigned_to: string | null;
  assigned_by: string | null;
  // The three uuids stay for the permission maths above. The names below are
  // purely presentational and are NOT used for any access decision - the
  // database decides that, not the client.
  created_by: string | null;
  creator: PersonRef | null;
  assigner: PersonRef | null;
  assignee: PersonRef | null;
};

type TaskHistory = {
  id: string;
  action: string;
  details: {
    task_title?: string;
    from_status?: string;
    to_status?: string;
    priority?: string;
    status?: string;
  } | null;
  created_at: string;
  user_id: string | null;
  profiles?: {
    full_name: string;
  } | null;
};
const statusOptions: {
  value: TaskStatus;
  label: string;
}[] = [
  {
    value: 'not_started',
    label: 'Not Started',
  },
  {
    value: 'in_progress',
    label: 'In Progress',
  },
  {
    value: 'waiting',
    label: 'Waiting',
  },
  {
    value: 'completed',
    label: 'Completed',
  },
];

export default function TaskDetailScreen() {
  const { id, readonly } = useLocalSearchParams<{
    id: string;
    readonly?: string;
  }>();

  // MONITORING MODE.
  //
  // Opened from a dashboard KPI list (a Director/Super Admin tapping "Active
  // Tasks" etc). The screen becomes a read-only observer: every write
  // affordance is suppressed below, and the activity data is read through
  // task_monitoring_snapshot() in migration 0022 - a STABLE, SECURITY DEFINER
  // function that can only ever return data, and returns nothing at all unless
  // the caller is entitled to see that task.
  const isMonitoring = readonly === '1';

  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [comments, setComments] = useState<any[]>([]);
  const [commentText, setCommentText] = useState('');
  const [commentLoading, setCommentLoading] = useState(true);
  const [commentSending, setCommentSending] = useState(false);

  // Holds the status selected by the user before confirmation
  const [selectedStatus, setSelectedStatus] =
  useState<TaskStatus | null>(null);

  const [extensionDate, setExtensionDate] = useState('');
  const [extensionReason, setExtensionReason] = useState('');
  const [extensionCategory, setExtensionCategory] = useState('');
  const [extensionSending, setExtensionSending] = useState(false);
  const [showExtensionForm, setShowExtensionForm] = useState(false);
  const [extensionSubmitted, setExtensionSubmitted] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Delegation chain
  const [parentTask, setParentTask] = useState<{ id: string; title: string } | null>(null);
  const [subtasks, setSubtasks] = useState<any[]>([]);

  // Only managers and above may delegate (employees never see the button).
  const [canDelegate, setCanDelegate] = useState(false);

  // Who am I, so the status controls can match the server-side governance in
  // migration 0020 (assignee reports progress; upline reviews; director overrides).
  const [meId, setMeId] = useState('');
  const [meRole, setMeRole] = useState('');

  useEffect(() => {
    (async () => {
      const me = await getSessionProfile();
      setCanDelegate(
        !!me && ['head', 'manager', 'director', 'super_admin'].includes(me.role)
      );
      setMeId(me?.id ?? '');
      setMeRole(me?.role ?? '');
    })();
  }, []);

async function loadComments() {
  if (!id) return;

  setCommentLoading(true);

  const { data, error } = await supabase
    .from('task_comments')
    .select(`
      id,
      comment,
      created_at,
      user_id,
      profiles:user_id (
        full_name
      )
    `)
    .eq('task_id', id)
    .order('created_at', { ascending: true });

  if (error) {
    console.log('Load comments error:', error.message);
    setCommentLoading(false);
    return;
  }

  setComments(data || []);
  setCommentLoading(false);
}

async function addComment() {
  if (!id || !commentText.trim() || commentSending) {
    return;
  }

  setCommentSending(true);

  // Cached local session read instead of an auth-server round-trip.
  const userId = await getMyId();

  if (!userId) {
    setCommentSending(false);
    Alert.alert('Error', 'You are not logged in.');
    return;
  }

  const { data, error } = await supabase
    .from('task_comments')
    .insert({
      task_id: id,
      user_id: userId,
      comment: commentText.trim(),
    })
    .select(`
      id,
      comment,
      created_at,
      user_id,
      profiles:user_id (
        full_name
      )
    `)
    .single();

  if (error) {
    console.log('Add comment error:', error.message);
    setCommentSending(false);
    Alert.alert('Unable to add comment', error.message);
    return;
  }

  setComments((current) => [...current, data]);
  setCommentText('');
  setCommentSending(false);
}

  // ---- MONITORING READ PATH ------------------------------------------------
  // In monitoring mode the whole activity view comes from ONE server call:
  // task_monitoring_snapshot() (migration 0022). That function is STABLE, so it
  // cannot write, and it is SECURITY DEFINER, so the entitlement check runs in
  // the database - a caller with no relationship to the task gets NULL rather
  // than data. Three separate client queries are also collapsed into one.
  async function loadMonitoringSnapshot() {
    if (!id) return;

    setLoading(true);
    setHistoryLoading(true);
    setCommentLoading(true);

    const { data, error } = await supabase.rpc('task_monitoring_snapshot', {
      p_task_id: id,
    });

    if (error) {
      console.log('Monitoring snapshot error:', error.message);
      setLoading(false);
      setHistoryLoading(false);
      setCommentLoading(false);
      return;
    }

    if (!data) {
      // Server refused: render nothing rather than a half-populated task.
      setTask(null);
      setHistory([]);
      setComments([]);
      setLoading(false);
      setHistoryLoading(false);
      setCommentLoading(false);
      return;
    }

    // The snapshot returns raw rows (an RPC has no PostgREST embedding), so
    // display names are hydrated here from the directory RLS already exposes.
    const rows = [
      ...((data.history ?? []) as any[]),
      ...((data.comments ?? []) as any[]),
    ];
    const taskRow = (data.task as any) ?? null;

    // One lookup covers both needs: the actors behind the history and the
    // comments, and the three attribution keys on the task itself. The RPC
    // gives us the uuids; the names come from this single query.
    const ids = [
      ...new Set(
        [
          ...rows.map((r) => r.user_id),
          taskRow?.created_by,
          taskRow?.assigned_by,
          taskRow?.assigned_to,
        ].filter(Boolean),
      ),
    ] as string[];

    const people = new Map<string, PersonRef>();

    if (ids.length) {
      const { data: found } = await supabase
        .from('profiles')
        .select('id, full_name, employee_id')
        .in('id', ids);

      (found ?? []).forEach((p) => people.set(p.id, p as PersonRef));
    }

    const withName = (row: any) => ({
      ...row,
      profiles: row.user_id ? { full_name: people.get(row.user_id)?.full_name } : null,
    });

    setHistory(((data.history ?? []) as any[]).map(withName));
    setComments(((data.comments ?? []) as any[]).map(withName));

    // Same three fields, shaped as the embedded objects the non-monitoring
    // query returns, so the JSX below has exactly one shape to render and
    // does not need to know which read path produced the task.
    if (taskRow) {
      setTask({
        ...(taskRow as Task),
        creator: people.get(taskRow.created_by) ?? null,
        assigner: people.get(taskRow.assigned_by) ?? null,
        assignee: people.get(taskRow.assigned_to) ?? null,
      });
    } else {
      setTask(null);
    }

    setLoading(false);
    setHistoryLoading(false);
    setCommentLoading(false);
  }

  useEffect(() => {
    if (isMonitoring) {
      loadMonitoringSnapshot();
      loadChain();
      return;
    }

    loadTask();
    loadHistory();
    loadComments();
    loadChain();
  }, [id, isMonitoring]);

async function loadChain() {
  if (!id) return;
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, status, due_date, assigned_to')
    .eq('parent_task_id', id)
    .order('created_at', { ascending: true });

  if (error) {
    console.log('Load subtasks error:', error.message);
    return;
  }

  setSubtasks(data ?? []);
}

  async function loadTask() {
    if (!id) return;

    // Literal select, not a template: supabase-js types the result from the
    // string, and an interpolated constant is opaque to that parser. The
    // `!<column>` hints pin each of the three joins to its own foreign key -
    // `tasks` has three onto `profiles` and PostgREST cannot tell them apart
    // otherwise. Must match lib/taskAttribution.ts.
    const { data, error } = await supabase
      .from('tasks')
      .select(
        'id, title, description, priority, status, due_date, start_date, created_at, completed_at, parent_task_id, created_by, assigned_by, assigned_to, creator:profiles!created_by(id, full_name, employee_id), assigner:profiles!assigned_by(id, full_name, employee_id), assignee:profiles!assigned_to(id, full_name, employee_id)'
      )
      .eq('id', id)
      .single();

    if (error) {
      console.log('Load task error:', error.message);

      Alert.alert(
        'Error',
        'Unable to load this task.'
      );

      goBack();
      return;
    }

    // withAttribution narrows the three embedded profiles; see
    // lib/taskAttribution.ts.
    setTask(withAttribution(data));
    setLoading(false);

    // Load the parent task (delegation chain upward).
    if (data.parent_task_id) {
      const { data: parent } = await supabase
        .from('tasks')
        .select('id, title')
        .eq('id', data.parent_task_id)
        .maybeSingle();

      setParentTask(parent ?? null);
    } else {
      setParentTask(null);
    }
  }

  async function loadHistory() {
  if (!id) return;

  setHistoryLoading(true);

 const { data, error } = await supabase
  .from('task_history')
  .select(`
    id,
    action,
    details,
    created_at,
    user_id,
    profiles:user_id (
      full_name
    )
  `)
  .eq('task_id', id)
  .order('created_at', { ascending: false });

  if (error) {
    console.log('Load history error:', error.message);
    setHistoryLoading(false);
    return;
  }

  setHistory(data || []);
  setHistoryLoading(false);
}

  function selectStatus(newStatus: TaskStatus) {
    if (!task || updating) {
      return;
    }

    if (task.status === newStatus) {
      setSelectedStatus(null);
      return;
    }

    setSelectedStatus(newStatus);
  }

async function confirmStatusUpdate() {
  if (!task || !selectedStatus || updating) {
    return;
  }

  setUpdating(true);

  const completedAt =
    selectedStatus === 'completed'
      ? new Date().toISOString()
      : null;

  const { data, error } = await supabase
    .from('tasks')
    .update({
      status: selectedStatus,
      completed_at: completedAt,
    })
    .eq('id', task.id)
    .select(
      'id, title, description, priority, status, due_date, start_date, created_at, completed_at, parent_task_id, assigned_to, assigned_by'
    )
    .single();

  if (error) {
    setUpdating(false);

    Alert.alert(
      'Unable to update',
      error.message
    );

    return;
  }

  // Status-change history (and the completion notice) are written by the
  // database trigger tasks_after_update, so they are always recorded.

    // Immediately update the screen. Spread over the existing task so the
    // attribution names loaded by loadTask() survive - this select only
    // returns the mutable columns, and blanking the names would make the
    // header flicker until the next full load.
    setTask({ ...task, ...data });

  // Remove confirmation area
  setSelectedStatus(null);

  setUpdating(false);

  // Return immediately to Tasks
  router.replace('/tasks');
}

  function cancelStatusUpdate() {
    if (updating) {
      return;
    }

    setSelectedStatus(null);
  }

  // ---- WHO MAY MOVE THIS TASK -----------------------------------------------
  // Mirrors migration 0020. The database is still the authority - if this ever
  // drifts, the server rejects the write and the error is shown to the user.
  //   doer     - the task is assigned to me: I report progress.
  //   reviewer - I assigned it, or I am above the assignee: I accept/reject.
  //   admin    - director / super admin: full override.
  const isDoer = !!task && !!meId && task.assigned_to === meId;
  const isAdmin = ['director', 'super_admin'].includes(meRole);
  const isReviewer =
    !!task &&
    !isDoer &&
    (task.assigned_by === meId ||
      ['head', 'manager', 'director', 'super_admin'].includes(meRole));

  const actor: TaskActor = isAdmin ? 'admin' : isDoer ? 'doer' : 'reviewer';

  // Only statuses the server will actually accept are offered.
  // In monitoring mode NOTHING is offered - that is what makes this view
  // read-only rather than merely looking read-only.
  const nextStatuses =
    isMonitoring || !task ? [] : allowedNextStatuses(task.status, actor);

  // Why the controls are hidden, phrased for whoever is looking.
  function statusLockedReason(): string {
    if (!task) return '';

    if (isMonitoring) {
      return 'You are monitoring this task. Change the status, comment, or request an extension from the task itself.';
    }

    if (task.status === 'completed') {
      return 'This task is completed and locked. Only a manager or director can reopen it.';
    }
    if (task.status === 'rejected') {
      return 'This task was rejected. Only a manager or director can send it back for rework.';
    }
    if (!isDoer) {
      return isReviewer
        ? 'This work is assigned to someone else, so only they can move it forward. You will be notified when it is completed and can then accept or reject it.'
        : 'This work is assigned to someone else and you are not in its chain of command, so you cannot change it.';
    }
    return 'No further status change is available for this task.';
  }

  function formatPriority(priority: string) {
    return priority.toUpperCase();
  }

  function formatStatus(status: string) {
    return status
      .replace('_', ' ')
      .toUpperCase();
  }

  function isOverdue() {
    if (
      !task?.due_date ||
      task.status === 'completed'
    ) {
      return false;
    }

    const today = new Date()
      .toISOString()
      .split('T')[0];

    return task.due_date < today;
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        {/* Skeleton holds the layout so the task content fades in instead of
            popping - same feel as the rest of the app. */}
        <View style={styles.header}>
          <AppPress onPress={() => goBack()} style={styles.backButton}>
            <Text style={styles.backText}>‹</Text>
          </AppPress>

          <View>
            <Text style={styles.headerTitle}>Task Details</Text>
            <Text style={styles.headerSubtitle}>Task information</Text>
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
        >
          <View style={styles.card}>
            <Skeleton width="80%" height={20} />
            <View style={{ height: 14 }} />
            <Skeleton width="100%" height={12} />
            <View style={{ height: 8 }} />
            <Skeleton width="70%" height={12} />
            <View style={{ height: 20 }} />
            <View style={{ flexDirection: 'row', gap: 24 }}>
              <Skeleton width={100} height={38} />
              <Skeleton width={100} height={38} />
            </View>
          </View>

          <View style={styles.actionCard}>
            <Skeleton width={140} height={18} />
            <View style={{ height: 14 }} />
            <Skeleton width="90%" height={12} />
            <View style={{ height: 16 }} />
            <Skeleton width="100%" height={44} radius={10} />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!task) {
    return null;
  }

  const overdue = isOverdue();
  // Computed once here rather than inline in the JSX, so the guard and the
  // list below can never disagree about how many lines are shown.
  const attribution = attributionRows(task);

  return (
    <SafeAreaView style={styles.container}>
      {/* HEADER */}
      <View style={styles.header}>
        <AppPress
          onPress={() => goBack()}
          style={styles.backButton}
        >
          <Text style={styles.backText}>‹</Text>
        </AppPress>

        <View>
          <Text style={styles.headerTitle}>
            Task Details
          </Text>

          <Text style={styles.headerSubtitle}>
            Task information
          </Text>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        {/* TASK INFORMATION */}
        <View style={styles.card}>
          <View style={styles.topRow}>
            <Text style={styles.title}>
              {task.title}
            </Text>

            <View style={styles.priorityBadge}>
              <Text style={styles.priorityText}>
                {formatPriority(task.priority)}
              </Text>
            </View>
          </View>

          {overdue && (
            <View style={styles.overdueBox}>
              <Text style={styles.overdueText}>
                OVERDUE
              </Text>
            </View>
          )}

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>
              DESCRIPTION
            </Text>

            <Text style={styles.description}>
              {task.description ||
                'No description provided.'}
            </Text>
          </View>

          <View style={styles.divider} />

          <View style={styles.infoRow}>
            <View style={styles.infoItem}>
              <Text style={styles.sectionLabel}>
                PRIORITY
              </Text>

              <Text style={styles.infoValue}>
                {formatPriority(task.priority)}
              </Text>
            </View>

            <View style={styles.infoItem}>
              <Text style={styles.sectionLabel}>
                DUE DATE
              </Text>

              <Text
                style={[
                  styles.infoValue,
                  overdue && styles.overdueDate,
                ]}
              >
                {task.due_date || 'No deadline'}
              </Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoItem}>
              <Text style={styles.sectionLabel}>
                START DATE
              </Text>

              <Text style={styles.infoValue}>
                {task.start_date || 'Not set'}
              </Text>
            </View>

            <View style={styles.infoItem}>
              <Text style={styles.sectionLabel}>
                CURRENT STATUS
              </Text>

              <Text style={styles.currentStatus}>
                {formatStatus(task.status)}
              </Text>
            </View>
          </View>

          {/* WHO IS INVOLVED - created by / assigned by / assigned to.
              The names are presentational only; the uuids above already
              decided which status buttons are shown. Absent profiles are
              dropped rather than rendered as "Unknown", so this block
              disappears entirely on a task with no resolvable people
              instead of leaving a hole in the card.

              attributionRow wraps rather than reusing infoRow: that one is a
              fixed two-up, and three names across two columns on a phone is
              too narrow to read. */}
          {attribution.length > 0 && (
            <View style={styles.attributionRow}>
              {attribution.map((row) => (
                <View key={row.label} style={styles.attributionItem}>
                  <Text style={styles.sectionLabel}>
                    {row.label}
                  </Text>

                  <Text style={styles.infoValue}>
                    {row.value}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {isMonitoring && (
            <View style={styles.monitorBanner}>
              <Ionicons name="eye-outline" size={16} color="#E87516" />
              <Text style={styles.monitorBannerText}>
                MONITORING — read only
              </Text>
            </View>
          )}
        </View>

        {/* DELEGATION CHAIN */}
        <View style={styles.actionCard}>
          <Text style={styles.actionTitle}>
            Delegation
          </Text>

          <Text style={styles.actionSubtitle}>
            Pass this work down and track who owns each step.
          </Text>

          {parentTask && (
            <AppPress
              style={styles.parentLink}
              onPress={() =>
                nav({
                  pathname: '/task-detail',
                  params: { id: parentTask.id },
                })
              }
            >
              <Ionicons name="arrow-up-circle-outline" size={18} color="#E87516" />
              <View style={{ flex: 1 }}>
                <Text style={styles.parentLinkLabel}>PARENT TASK</Text>
                <Text style={styles.parentLinkTitle} numberOfLines={2}>
                  {parentTask.title}
                </Text>
              </View>
            </AppPress>
          )}

          {subtasks.length > 0 && (
            <View style={styles.subtaskList}>
              <Text style={styles.subtaskHeading}>
                SUB-TASKS ({subtasks.length})
              </Text>

              {subtasks.map((s) => (
                <AppPress
                  key={s.id}
                  style={styles.subtaskRow}
                  onPress={() =>
                    nav({
                      pathname: '/task-detail',
                      params: { id: s.id },
                    })
                  }
                >
                  <View
                    style={[
                      styles.subtaskDot,
                      { backgroundColor: statusColor(s.status) },
                    ]}
                  />
                  <Text style={styles.subtaskTitle} numberOfLines={1}>
                    {s.title}
                  </Text>
                  <Text style={styles.subtaskMeta}>
                    {s.due_date || 'No deadline'}
                  </Text>
                </AppPress>
              ))}
            </View>
          )}

          {canDelegate && !isMonitoring && (
            <AppPress
              style={styles.delegateButton}
              onPress={() =>
                nav({
                  pathname: '/create-task',
                  params: { parentTaskId: task.id, parentTitle: task.title },
                })
              }
            >
              <Ionicons name="git-branch-outline" size={18} color="#FFFFFF" />
              <Text style={styles.delegateButtonText}>
                DELEGATE AS SUB-TASK
              </Text>
            </AppPress>
          )}
        </View>

        {/* STATUS UPDATE */}
        <View style={styles.actionCard}>
          <Text style={styles.actionTitle}>
            Update Status
          </Text>

          <Text style={styles.actionSubtitle}>
            {nextStatuses.length === 0
              ? 'No status change is available to you.'
              : 'Select the new status for this task.'}
          </Text>

          {nextStatuses.length === 0 && (
            <Text style={styles.statusLockedNote}>{statusLockedReason()}</Text>
          )}

          <View style={styles.statusList}>
            {statusOptions
              .filter((option) => nextStatuses.includes(option.value))
              .map((option) => {
              const current =
                task.status === option.value;

              const selected =
                selectedStatus === option.value;

              return (
                <AppPress
                  key={option.value}
                  style={[
                    styles.statusButton,
                    current &&
                      styles.statusButtonCurrent,
                    selected &&
                      styles.statusButtonSelected,
                  ]}
                  disabled={updating}
                  onPress={() =>
                    selectStatus(option.value)
                  }
                >
                  <View
                    style={[
                      styles.statusCircle,
                      current &&
                        styles.statusCircleCurrent,
                      selected &&
                        styles.statusCircleSelected,
                    ]}
                  >
                    {(current || selected) && (
                      <View
                        style={
                          styles.statusCircleInner
                        }
                      />
                    )}
                  </View>

                  <Text
                    style={[
                      styles.statusButtonText,
                      current &&
                        styles.statusButtonTextCurrent,
                      selected &&
                        styles.statusButtonTextSelected,
                    ]}
                  >
                    {option.label}
                  </Text>

                  {current && (
                    <View style={styles.currentBadge}>
                      <Text
                        style={styles.currentBadgeText}
                      >
                        CURRENT
                      </Text>
                    </View>
                  )}
                </AppPress>
              );
            })}
          </View>

          {/* CONFIRMATION AREA */}
          {selectedStatus && (
            <View style={styles.confirmBox}>
              <Text style={styles.confirmTitle}>
                Confirm Status Change
              </Text>

              <Text style={styles.confirmText}>
                Change status from{' '}
                <Text style={styles.confirmStrong}>
                  {formatStatus(task.status)}
                </Text>{' '}
                to{' '}
                <Text style={styles.confirmStrong}>
                  {formatStatus(selectedStatus)}
                </Text>
                ?
              </Text>

              <View style={styles.confirmButtons}>
                <AppPress
                  style={styles.cancelButton}
                  onPress={cancelStatusUpdate}
                  disabled={updating}
                >
                  <Text style={styles.cancelButtonText}>
                    CANCEL
                  </Text>
                </AppPress>

                <AppPress
                  style={[
                    styles.confirmButton,
                    updating &&
                      styles.confirmButtonDisabled,
                  ]}
                  onPress={confirmStatusUpdate}
                  disabled={updating}
                >
                  {updating ? (
                    <ActivityIndicator
                      size="small"
                      color="#FFFFFF"
                    />
                  ) : (
                    <Text
                      style={styles.confirmButtonText}
                    >
                      CONFIRM UPDATE
                    </Text>
                  )}
                </AppPress>
              </View>
            </View>
          )}
        </View>

        {/* REQUEST EXTENSION - hidden entirely in monitoring mode, since a
            monitor must never be able to alter the task they are watching. */}
        {!isMonitoring && (
        <View style={styles.actionCard}>
  <Text style={styles.actionTitle}>
    Request Extension
  </Text>

  <Text style={styles.actionSubtitle}>
    Need more time? Request a new deadline with a reason.
  </Text>

  {!showExtensionForm ? (
    <AppPress
      style={styles.extensionButton}
      onPress={() => setShowExtensionForm(true)}
    >
      <Ionicons
        name="calendar-outline"
        size={18}
        color="#FFFFFF"
      />

      <Text style={styles.extensionButtonText}>
        REQUEST EXTENSION
      </Text>
    </AppPress>
  ) : (
    <View>
      <Text style={styles.extensionLabel}>
        NEW DUE DATE
      </Text>

      {Platform.OS === 'web' ? (
        <View style={styles.extensionDateWebWrapper}>
          {React.createElement('input', {
            type: 'date',
            value: extensionDate,
            min: (() => {
              if (task?.due_date) {
                const date = new Date(`${task.due_date}T00:00:00`);
                date.setDate(date.getDate() + 1);
                return date.toISOString().split('T')[0];
              }

              return new Date().toISOString().split('T')[0];
            })(),
            onChange: (event: any) => {
              setExtensionDate(event.currentTarget.value);
            },
            style: {
              width: '100%',
              height: 45,
              border: '1px solid #E1E5E9',
              borderRadius: 10,
              backgroundColor: '#F4F6F8',
              padding: '0 12px',
              color: '#12233F',
              fontSize: 13,
              boxSizing: 'border-box',
              fontFamily: 'inherit',
              cursor: 'pointer',
              outline: 'none',
            },
          })}
        </View>
      ) : (
        <>
          <AppPress
            style={styles.extensionInput}
            onPress={() => setShowDatePicker(true)}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text
                style={{
                  color: extensionDate ? '#12233F' : '#9AA2AC',
                  fontSize: 13,
                }}
              >
                {extensionDate || 'Select new due date'}
              </Text>

              <Ionicons
                name="calendar-outline"
                size={20}
                color="#E87516"
              />
            </View>
          </AppPress>

          {showDatePicker && (
            <DateTimePicker
              value={
                extensionDate
                  ? new Date(`${extensionDate}T00:00:00`)
                  : task?.due_date
                    ? new Date(`${task.due_date}T00:00:00`)
                    : new Date()
              }
              mode="date"
              display={Platform.OS === 'android' ? 'calendar' : 'default'}
              minimumDate={
                (() => {
                  const date = task?.due_date
                    ? new Date(`${task.due_date}T00:00:00`)
                    : new Date();
                  date.setDate(date.getDate() + (task?.due_date ? 1 : 0));
                  return date;
                })()
              }
              onChange={(event, selectedDate) => {
                if (event.type === 'dismissed') {
                  setShowDatePicker(false);
                  return;
                }

                if (selectedDate) {
                  const year = selectedDate.getFullYear();
                  const month = String(
                    selectedDate.getMonth() + 1
                  ).padStart(2, '0');
                  const day = String(
                    selectedDate.getDate()
                  ).padStart(2, '0');

                  setExtensionDate(
                    `${year}-${month}-${day}`
                  );
                }

                setShowDatePicker(false);
              }}
            />
          )}
        </>
      )}
      <Text style={styles.extensionLabel}>
        REASON
      </Text>

      <View style={styles.reasonChipsWrap}>
        {EXTENSION_REASONS.map((r) => {
          const active = extensionCategory === r;
          return (
            <AppPress
              key={r}
              style={[styles.reasonChip, active && styles.reasonChipActive]}
              onPress={() => setExtensionCategory(r)}
            >
              <Text
                style={[
                  styles.reasonChipText,
                  active && styles.reasonChipTextActive,
                ]}
              >
                {r}
              </Text>
            </AppPress>
          );
        })}
      </View>

      <Text style={styles.extensionLabel}>
        {extensionCategory === 'Other'
          ? 'EXPLANATION (REQUIRED)'
          : 'ADDITIONAL NOTE (OPTIONAL)'}
      </Text>

      <TextInput
        value={extensionReason}
        onChangeText={setExtensionReason}
        placeholder="Add any details for your manager"
        placeholderTextColor="#9AA2AC"
        multiline
        style={[
          styles.extensionInput,
          styles.extensionReasonInput,
        ]}
      />


      <View style={styles.extensionButtons}>
        <AppPress
          style={styles.extensionCancelButton}
          onPress={() => {
            setShowExtensionForm(false);
            setExtensionDate('');
            setExtensionReason('');
            setExtensionCategory('');
          }}
          disabled={extensionSending}
        >
          <Text style={styles.extensionCancelText}>
            CANCEL
          </Text>
        </AppPress>

        <AppPress
          style={[
            styles.extensionSubmitButton,
            extensionSending &&
              styles.extensionSubmitDisabled,
          ]}
          disabled={extensionSending}
          onPress={async () => {
            if (!extensionDate.trim() || !extensionCategory) {
              Alert.alert(
                'Missing Information',
                'Please select a new due date and a reason category.'
              );
              return;
            }

            if (
              extensionCategory === 'Other' &&
              !extensionReason.trim()
            ) {
              Alert.alert(
                'Missing Information',
                'Please explain the reason when selecting "Other".'
              );
              return;
            }

            if (!/^\d{4}-\d{2}-\d{2}$/.test(extensionDate.trim())) {
              Alert.alert(
                'Invalid Date',
                'Please select a valid new due date.'
              );
              return;
            }

            if (
              task?.due_date &&
              extensionDate.trim() <= task.due_date
            ) {
              Alert.alert(
                'Invalid Date',
                'The new due date must be later than the current due date.'
              );
              return;
            }

            if (!task) {
              return;
            }

            setExtensionSending(true);

            // Cached local session read instead of an auth-server round-trip.
            const userId = await getMyId();

            if (!userId) {
              setExtensionSending(false);
              Alert.alert(
                'Error',
                'You are not logged in.'
              );
              return;
            }

            const { error } = await supabase
              .from('task_extensions')
              .insert({
                task_id: task.id,
                requested_by: userId,
                old_due_date: task.due_date,
                requested_due_date: extensionDate.trim(),
                reason: extensionReason.trim()
                  ? `${extensionCategory} — ${extensionReason.trim()}`
                  : extensionCategory,
                status: 'pending',
              });

            if (error) {
              console.log(
                'Extension request error:',
                error.message
              );

              setExtensionSending(false);

              Alert.alert(
                'Unable to submit request',
                error.message
              );

              return;
            }

            setExtensionSending(false);
            setShowExtensionForm(false);
            setExtensionDate('');
            setExtensionReason('');
            setExtensionCategory('');
            setExtensionSubmitted(true);

            Alert.alert(
              'Request Submitted',
              'Your extension request has been submitted for approval.'
            );
          }}
        >
          {extensionSending ? (
            <ActivityIndicator
              size="small"
              color="#FFFFFF"
            />
          ) : (
            <Text style={styles.extensionSubmitText}>
              SUBMIT REQUEST
            </Text>
          )}
        </AppPress>
      </View>
    </View>
    )}

  {extensionSubmitted && (
    <View style={styles.extensionSuccessBox}>
      <Ionicons
        name="checkmark-circle"
        size={24}
        color="#2E8B57"
      />

      <View style={{ flex: 1 }}>
        <Text style={styles.extensionSuccessTitle}>
          Extension Request Submitted
        </Text>

        <Text style={styles.extensionSuccessText}>
          Your request has been submitted successfully and is Pending Approval.
        </Text>
      </View>
    </View>
  )}
</View>
)}

        {/* TASK HISTORY */}
<View style={styles.historyCard}>
  <View style={styles.historyHeader}>
    <View>
      <Text style={styles.historyTitle}>
        Task History
      </Text>

      <Text style={styles.historySubtitle}>
        Activity recorded for this task
      </Text>
    </View>

    <Ionicons
      name="time-outline"
      size={22}
      color="#E87516"
    />
  </View>

  {historyLoading ? (
    <View style={styles.historyLoading}>
      <ActivityIndicator size="small" />

      <Text style={styles.historyLoadingText}>
        Loading history...
      </Text>
    </View>
  ) : history.length === 0 ? (
    <View style={styles.emptyHistory}>
      <Ionicons
        name="document-text-outline"
        size={28}
        color="#A8B0BA"
      />

      <Text style={styles.emptyHistoryText}>
        No history recorded yet.
      </Text>
    </View>
  ) : (
    <View style={styles.historyList}>
      {history.map((item, index) => {
        const details = item.details || {};

        let actionTitle = 'Task Activity';
        let actionDescription = '';

        if (item.action === 'task_created') {
          actionTitle = 'Task Created';
          actionDescription = 'Task was created.';
        } else if (item.action === 'status_changed') {
          actionTitle = 'Status Changed';

          actionDescription =
            `${formatStatus(details.from_status || '')} → ` +
            `${formatStatus(details.to_status || '')}`;
        }

        const date = new Date(item.created_at);

        const formattedDate = date.toLocaleDateString();
        const formattedTime = date.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });

        return (
          <View
            key={item.id}
            style={styles.historyItem}
          >
            <View style={styles.historyTimeline}>
              <View style={styles.historyDot} />

              {index !== history.length - 1 && (
                <View style={styles.historyLine} />
              )}
            </View>

            <View style={styles.historyContent}>
              <Text style={styles.historyAction}>
                {actionTitle}
              </Text>

              {details.task_title && (
                <Text style={styles.historyTaskTitle}>
                  {details.task_title}
                </Text>
              )}

              <Text style={styles.historyDescription}>
                {actionDescription}
              </Text>

              {item.profiles?.full_name && (
                <Text style={styles.historyUser}>
                 By: {item.profiles.full_name}
                 </Text>
                )}

              <Text style={styles.historyDate}>
                {formattedDate} • {formattedTime}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  )}
        </View>

        {/* COMMENTS */}
        <View style={styles.historyCard}>
          <View style={styles.historyHeader}>
            <View>
              <Text style={styles.historyTitle}>
                Comments
              </Text>

              <Text style={styles.historySubtitle}>
                Updates and discussion for this task
              </Text>
            </View>

            <Ionicons
              name="chatbubble-outline"
              size={22}
              color="#E87516"
            />
          </View>

          {commentLoading ? (
            <View style={styles.historyLoading}>
              <ActivityIndicator size="small" />

              <Text style={styles.historyLoadingText}>
                Loading comments...
              </Text>
            </View>
          ) : comments.length === 0 ? (
            <View style={styles.emptyHistory}>
              <Ionicons
                name="chatbubble-ellipses-outline"
                size={28}
                color="#A8B0BA"
              />

              <Text style={styles.emptyHistoryText}>
                No comments yet.
              </Text>
            </View>
          ) : (
            <View style={styles.historyList}>
              {comments.map((item) => (
                <View
                  key={item.id}
                  style={styles.historyItem}
                >
                  <View style={styles.historyTimeline}>
                    <View style={styles.historyDot} />
                  </View>

                  <View style={styles.historyContent}>
                    <Text style={styles.historyAction}>
                      {item.profiles?.full_name || 'User'}
                    </Text>

                    <Text style={styles.historyDescription}>
                      {item.comment}
                    </Text>

                    <Text style={styles.historyDate}>
                      {new Date(item.created_at).toLocaleDateString()} •{' '}
                      {new Date(item.created_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Read-only in monitoring mode: a monitor observes the conversation
              but never joins it. */}
          {!isMonitoring && (
          <View style={styles.commentInputRow}>
            <TextInput
              value={commentText}
              onChangeText={setCommentText}
              placeholder="Write a comment..."
              placeholderTextColor="#9AA2AC"
              multiline
              style={styles.commentInput}
            />

            <AppPress
              style={[
                styles.commentSendButton,
                (!commentText.trim() || commentSending) &&
                  styles.commentSendButtonDisabled,
              ]}
              onPress={addComment}
              disabled={!commentText.trim() || commentSending}
            >
              {commentSending ? (
                <ActivityIndicator
                  size="small"
                  color="#FFFFFF"
                />
              ) : (
                <Ionicons
                  name="send"
                  size={18}
                  color="#FFFFFF"
                />
              )}
            </AppPress>
          </View>
          )}

          {isMonitoring && (
            <View style={styles.monitorNote}>
              <Ionicons
                name="eye-outline"
                size={15}
                color="#66717F"
              />
              <Text style={styles.monitorNoteText}>
                Monitoring view — read only. Open the task to comment or change
                its status.
              </Text>
            </View>
          )}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F4F6F8',
  },

  header: {
    backgroundColor: '#12233F',
    paddingHorizontal: 25,
    paddingTop: 46,
    paddingBottom: 15,
    borderBottomLeftRadius: 25,
    borderBottomRightRadius: 25,
    flexDirection: 'row',
    alignItems: 'center',
  },

  backButton: {
    width: 42,
    height: 42,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },

  backText: {
    color: '#FFFFFF',
    fontSize: 38,
    fontWeight: '300',
    lineHeight: 38,
  },

  headerTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '900',
  },

  headerSubtitle: {
    color: '#B9C2CF',
    fontSize: 11,
    marginTop: 2,
  },

  content: {
    padding: 16,
    paddingBottom: 40,
  },

  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: '#E2E6EA',
  },

  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },

  title: {
    flex: 1,
    color: '#12233F',
    fontSize: 21,
    fontWeight: '900',
    marginRight: 10,
  },

  priorityBadge: {
    backgroundColor: '#FFF0E5',
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 7,
  },

  priorityText: {
    color: '#E87516',
    fontSize: 9,
    fontWeight: '900',
  },

  overdueBox: {
    backgroundColor: '#FDEBEC',
    borderRadius: 7,
    paddingVertical: 7,
    paddingHorizontal: 10,
    alignSelf: 'flex-start',
    marginTop: 14,
  },

  overdueText: {
    color: '#D64545',
    fontSize: 10,
    fontWeight: '900',
  },

  section: {
    marginTop: 21,
  },

  sectionLabel: {
    color: '#9AA2AC',
    fontSize: 9,
    fontWeight: '900',
    marginBottom: 6,
  },

  description: {
    color: '#4E5865',
    fontSize: 14,
    lineHeight: 21,
  },

  divider: {
    height: 1,
    backgroundColor: '#E8EBEE',
    marginVertical: 20,
  },

  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 18,
  },

  infoItem: {
    flex: 1,
  },

  // Three names do not fit two-up on a phone, so this row wraps instead.
  attributionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: 16,
    marginBottom: 18,
  },

  attributionItem: {
    // Roughly half a phone width, so two sit per line and the third wraps
    // cleanly instead of all three squeezing onto one.
    minWidth: '46%',
    flexGrow: 1,
  },

  infoValue: {
    color: '#12233F',
    fontSize: 12,
    fontWeight: '800',
  },

  currentStatus: {
    color: '#E87516',
    fontSize: 12,
    fontWeight: '900',
  },

  overdueDate: {
    color: '#D64545',
  },

  actionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 18,
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#E2E6EA',
  },

  actionTitle: {
    color: '#12233F',
    fontSize: 17,
    fontWeight: '900',
  },

  actionSubtitle: {
    color: '#7A8491',
    fontSize: 11,
    marginTop: 4,
    marginBottom: 14,
  },

  // Shown in place of the status buttons when the viewer is not allowed to
  // move this task - explains the workflow instead of silently hiding controls.
  statusLockedNote: {
    color: COLORS.textSoft,
    fontSize: 12,
    lineHeight: 18,
    backgroundColor: COLORS.bg,
    borderRadius: 10,
    padding: 12,
  },

  statusList: {
    gap: 8,
  },

  statusButton: {
    minHeight: 50,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E1E5E9',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 13,
  },

  statusButtonCurrent: {
    borderColor: '#E87516',
    backgroundColor: '#FFF7F0',
  },

  statusButtonSelected: {
    borderColor: '#12233F',
    backgroundColor: '#F1F4F8',
  },

  statusCircle: {
    width: 19,
    height: 19,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#B7BEC6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 11,
  },

  statusCircleCurrent: {
    borderColor: '#E87516',
  },

  statusCircleSelected: {
    borderColor: '#12233F',
  },

  statusCircleInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#E87516',
  },

  statusButtonText: {
    color: '#4E5865',
    fontSize: 13,
    fontWeight: '700',
  },

  statusButtonTextCurrent: {
    color: '#E87516',
    fontWeight: '900',
  },

  statusButtonTextSelected: {
    color: '#12233F',
    fontWeight: '900',
  },

  currentBadge: {
    marginLeft: 'auto',
    backgroundColor: '#FFF0E5',
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 5,
  },

  currentBadgeText: {
    color: '#E87516',
    fontSize: 8,
    fontWeight: '900',
  },

  confirmBox: {
    backgroundColor: '#F4F6F8',
    borderRadius: 12,
    padding: 14,
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#DCE1E6',
  },

  confirmTitle: {
    color: '#12233F',
    fontSize: 14,
    fontWeight: '900',
  },

  confirmText: {
    color: '#68727E',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
  },

  confirmStrong: {
    color: '#12233F',
    fontWeight: '900',
  },

  confirmButtons: {
    flexDirection: 'row',
    gap: 9,
    marginTop: 13,
  },

  cancelButton: {
    flex: 1,
    minHeight: 45,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#C9CED4',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },

  cancelButtonText: {
    color: '#68727E',
    fontSize: 10,
    fontWeight: '900',
  },

  confirmButton: {
    flex: 1.5,
    minHeight: 45,
    borderRadius: 9,
    backgroundColor: '#E87516',
    justifyContent: 'center',
    alignItems: 'center',
  },

  confirmButtonDisabled: {
    opacity: 0.7,
  },

  confirmButtonText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
  },

  comingCard: {
    backgroundColor: '#12233F',
    borderRadius: 16,
    padding: 18,
    marginTop: 14,
  },

  comingTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
  },

  comingText: {
    color: '#B9C2CF',
    fontSize: 11,
    lineHeight: 17,
    marginTop: 6,
  },

  historyCard: {
  backgroundColor: '#FFFFFF',
  borderRadius: 16,
  padding: 18,
  marginTop: 14,
  borderWidth: 1,
  borderColor: '#E2E6EA',
},

historyHeader: {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 18,
},

historyTitle: {
  color: '#12233F',
  fontSize: 17,
  fontWeight: '900',
},

historySubtitle: {
  color: '#7A8491',
  fontSize: 11,
  marginTop: 4,
},

historyLoading: {
  alignItems: 'center',
  paddingVertical: 20,
},

historyLoadingText: {
  color: '#7A8491',
  fontSize: 11,
  marginTop: 8,
},

emptyHistory: {
  alignItems: 'center',
  paddingVertical: 20,
},

emptyHistoryText: {
  color: '#8A939E',
  fontSize: 12,
  marginTop: 8,
},

historyList: {
  marginTop: 2,
},

historyItem: {
  flexDirection: 'row',
  minHeight: 75,
},

historyTimeline: {
  width: 24,
  alignItems: 'center',
},

historyDot: {
  width: 11,
  height: 11,
  borderRadius: 6,
  backgroundColor: '#E87516',
  marginTop: 4,
},

historyLine: {
  width: 2,
  flex: 1,
  backgroundColor: '#E2E6EA',
  marginTop: 4,
  marginBottom: -4,
},

historyContent: {
  flex: 1,
  paddingLeft: 8,
  paddingBottom: 18,
},

historyAction: {
  color: '#12233F',
  fontSize: 13,
  fontWeight: '900',
},

historyTaskTitle: {
  color: '#E87516',
  fontSize: 12,
  fontWeight: '800',
  marginTop: 4,
},

historyDescription: {
  color: '#596472',
  fontSize: 11,
  marginTop: 4,
},

historyDate: {
  color: '#9AA2AC',
  fontSize: 10,
  marginTop: 5,
},

historyUser: {
  color: '#7A8491',
  fontSize: 10,
  fontWeight: '700',
  marginTop: 4,
},

monitorBanner: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 7,
  marginTop: 14,
  alignSelf: 'flex-start',
  paddingHorizontal: 11,
  paddingVertical: 7,
  borderRadius: 15,
  backgroundColor: '#FFF0E5',
},
monitorBannerText: {
  color: '#D9630A',
  fontSize: 10,
  fontWeight: '900',
  letterSpacing: 0.8,
},

monitorNote: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
  marginTop: 14,
  paddingHorizontal: 12,
  paddingVertical: 10,
  borderRadius: 8,
  backgroundColor: '#F4F6F8',
},
monitorNoteText: {
  flex: 1,
  color: '#66717F',
  fontSize: 11,
  lineHeight: 15,
},

commentInputRow: {
  flexDirection: 'row',
  alignItems: 'flex-end',
  marginTop: 10,
  gap: 8,
},

commentInput: {
  flex: 1,
  minHeight: 45,
  maxHeight: 100,
  backgroundColor: '#F4F6F8',
  borderWidth: 1,
  borderColor: '#E1E5E9',
  borderRadius: 10,
  paddingHorizontal: 12,
  paddingVertical: 10,
  color: '#12233F',
  fontSize: 13,
  textAlignVertical: 'top',
},

commentSendButton: {
  width: 45,
  height: 45,
  borderRadius: 10,
  backgroundColor: '#E87516',
  justifyContent: 'center',
  alignItems: 'center',
},

commentSendButtonDisabled: {
  opacity: 0.45,
},

extensionButton: {
  minHeight: 48,
  borderRadius: 10,
  backgroundColor: '#E87516',
  flexDirection: 'row',
  justifyContent: 'center',
  alignItems: 'center',
  gap: 8,
},

extensionButtonText: {
  color: '#FFFFFF',
  fontSize: 11,
  fontWeight: '900',
},

extensionLabel: {
  color: '#9AA2AC',
  fontSize: 9,
  fontWeight: '900',
  marginTop: 12,
  marginBottom: 6,
},

extensionDateWebWrapper: {
  width: '100%',
  minHeight: 45,
},

extensionInput: {
  minHeight: 45,
  backgroundColor: '#F4F6F8',
  borderWidth: 1,
  borderColor: '#E1E5E9',
  borderRadius: 10,
  paddingHorizontal: 12,
  paddingVertical: 10,
  color: '#12233F',
  fontSize: 13,
},

extensionReasonInput: {
  minHeight: 85,
  textAlignVertical: 'top',
},

extensionButtons: {
  flexDirection: 'row',
  gap: 9,
  marginTop: 14,
},

extensionCancelButton: {
  flex: 1,
  minHeight: 45,
  borderRadius: 9,
  borderWidth: 1,
  borderColor: '#C9CED4',
  justifyContent: 'center',
  alignItems: 'center',
  backgroundColor: '#FFFFFF',
},

extensionCancelText: {
  color: '#68727E',
  fontSize: 10,
  fontWeight: '900',
},

extensionSubmitButton: {
  flex: 1.5,
  minHeight: 45,
  borderRadius: 9,
  backgroundColor: '#E87516',
  justifyContent: 'center',
  alignItems: 'center',
},

extensionSubmitDisabled: {
  opacity: 0.7,
},

extensionSubmitText: {
  color: '#FFFFFF',
  fontSize: 10,
  fontWeight: '900',
},

extensionSuccessBox: {
  marginTop: 14,
  padding: 14,
  borderRadius: 10,
  backgroundColor: '#EAF7EF',
  borderWidth: 1,
  borderColor: '#B8DFC5',
  flexDirection: 'row',
  alignItems: 'center',
  gap: 10,
},

extensionSuccessTitle: {
  color: '#246B45',
  fontSize: 12,
  fontWeight: '900',
  marginBottom: 3,
},

extensionSuccessText: {
  color: '#4F6B5A',
  fontSize: 11,
  lineHeight: 16,
},

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  loadingText: {
    color: '#7A8491',
    marginTop: 10,
    fontSize: 13,
  },

  reasonChipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginBottom: 4,
  },

  reasonChip: {
    borderWidth: 1,
    borderColor: '#DCE1E6',
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },

  reasonChipActive: {
    backgroundColor: COLORS.navy,
    borderColor: COLORS.navy,
  },

  reasonChipText: {
    color: '#687382',
    fontSize: 11,
    fontWeight: '700',
  },

  reasonChipTextActive: {
    color: '#FFFFFF',
    fontWeight: '900',
  },

  parentLink: {
    marginTop: 14,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#FFF7F0',
    borderWidth: 1,
    borderColor: '#F3D1B3',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },

  parentLinkLabel: {
    color: '#9A6B3F',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
  },

  parentLinkTitle: {
    color: '#12233F',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 3,
  },

  subtaskList: {
    marginTop: 14,
  },

  subtaskHeading: {
    color: '#9AA2AC',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
    marginBottom: 8,
  },

  subtaskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F2F4',
    gap: 9,
  },

  subtaskDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },

  subtaskTitle: {
    flex: 1,
    color: '#12233F',
    fontSize: 12,
    fontWeight: '700',
  },

  subtaskMeta: {
    color: '#9AA2AC',
    fontSize: 10,
  },

  delegateButton: {
    minHeight: 48,
    borderRadius: 10,
    backgroundColor: '#12233F',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
  },

  delegateButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
});
