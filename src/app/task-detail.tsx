import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { supabase } from '../../lib/supabase';
import { getCurrentProfile } from '../../lib/auth';
import { COLORS, EXTENSION_REASONS, statusColor } from '../constants/app';

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
  const { id } = useLocalSearchParams<{ id: string }>();

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

  useEffect(() => {
    (async () => {
      const me = await getCurrentProfile();
      setCanDelegate(
        !!me && ['head', 'manager', 'director', 'super_admin'].includes(me.role)
      );
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    setCommentSending(false);
    Alert.alert('Error', 'You are not logged in.');
    return;
  }

  const { data, error } = await supabase
    .from('task_comments')
    .insert({
      task_id: id,
      user_id: user.id,
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

useEffect(() => {
  loadTask();
  loadHistory();
  loadComments();
  loadChain();
}, [id]);

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

    const { data, error } = await supabase
      .from('tasks')
      .select(
        'id, title, description, priority, status, due_date, start_date, created_at, completed_at, parent_task_id'
      )
      .eq('id', id)
      .single();

    if (error) {
      console.log('Load task error:', error.message);

      Alert.alert(
        'Error',
        'Unable to load this task.'
      );

      router.back();
      return;
    }

    setTask(data);
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
      'id, title, description, priority, status, due_date, start_date, created_at, completed_at, parent_task_id'
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

  // Immediately update the screen
  setTask(data);

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
        <View style={styles.center}>
          <ActivityIndicator size="large" />

          <Text style={styles.loadingText}>
            Loading task...
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!task) {
    return null;
  }

  const overdue = isOverdue();

  return (
    <SafeAreaView style={styles.container}>
      {/* HEADER */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>

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
            <TouchableOpacity
              style={styles.parentLink}
              activeOpacity={0.8}
              onPress={() =>
                router.push({
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
            </TouchableOpacity>
          )}

          {subtasks.length > 0 && (
            <View style={styles.subtaskList}>
              <Text style={styles.subtaskHeading}>
                SUB-TASKS ({subtasks.length})
              </Text>

              {subtasks.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={styles.subtaskRow}
                  activeOpacity={0.85}
                  onPress={() =>
                    router.push({
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
                </TouchableOpacity>
              ))}
            </View>
          )}

          {canDelegate && (
            <TouchableOpacity
              style={styles.delegateButton}
              activeOpacity={0.85}
              onPress={() =>
                router.push({
                  pathname: '/create-task',
                  params: { parentTaskId: task.id, parentTitle: task.title },
                })
              }
            >
              <Ionicons name="git-branch-outline" size={18} color="#FFFFFF" />
              <Text style={styles.delegateButtonText}>
                DELEGATE AS SUB-TASK
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* STATUS UPDATE */}
        <View style={styles.actionCard}>
          <Text style={styles.actionTitle}>
            Update Status
          </Text>

          <Text style={styles.actionSubtitle}>
            Select the new status for this task.
          </Text>

          <View style={styles.statusList}>
            {statusOptions.map((option) => {
              const current =
                task.status === option.value;

              const selected =
                selectedStatus === option.value;

              return (
                <TouchableOpacity
                  key={option.value}
                  style={[
                    styles.statusButton,
                    current &&
                      styles.statusButtonCurrent,
                    selected &&
                      styles.statusButtonSelected,
                  ]}
                  activeOpacity={0.8}
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
                </TouchableOpacity>
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
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={cancelStatusUpdate}
                  disabled={updating}
                >
                  <Text style={styles.cancelButtonText}>
                    CANCEL
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
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
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* REQUEST EXTENSION */}
<View style={styles.actionCard}>
  <Text style={styles.actionTitle}>
    Request Extension
  </Text>

  <Text style={styles.actionSubtitle}>
    Need more time? Request a new deadline with a reason.
  </Text>

  {!showExtensionForm ? (
    <TouchableOpacity
      style={styles.extensionButton}
      activeOpacity={0.8}
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
    </TouchableOpacity>
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
          <TouchableOpacity
            style={styles.extensionInput}
            activeOpacity={0.8}
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
          </TouchableOpacity>

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
            <TouchableOpacity
              key={r}
              style={[styles.reasonChip, active && styles.reasonChipActive]}
              activeOpacity={0.8}
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
            </TouchableOpacity>
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
        <TouchableOpacity
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
        </TouchableOpacity>

        <TouchableOpacity
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

            const {
              data: { user },
            } = await supabase.auth.getUser();

            if (!user) {
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
                requested_by: user.id,
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
        </TouchableOpacity>
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

          <View style={styles.commentInputRow}>
            <TextInput
              value={commentText}
              onChangeText={setCommentText}
              placeholder="Write a comment..."
              placeholderTextColor="#9AA2AC"
              multiline
              style={styles.commentInput}
            />

            <TouchableOpacity
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
            </TouchableOpacity>
          </View>
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