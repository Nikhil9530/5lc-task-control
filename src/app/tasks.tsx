import { Ionicons } from '@expo/vector-icons';
import { goBack, nav } from '../../lib/navigation';
import { getMyId, getSessionProfile } from '../../lib/auth';
import { memo, useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import {
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { supabase } from '../../lib/supabase';
import { AppPress, EmptyState, SkeletonCard } from '../../lib/ui';

// The four dashboard KPI cards deep-link here with ?filter=<key>.
//
// WHY THE PREDICATES ARE COPIED VERBATIM
// -------------------------------------
// These MUST stay identical to the filters inside dashboard_counts() in
// migration 0019. If they drift, the number on the card stops matching the
// length of the list it opens, which reads as a bug to the user even though
// both screens are individually "correct". Change one, change both.
type TaskFilter = 'active' | 'due_today' | 'overdue' | 'completed_today';

const FILTER_TITLES: Record<TaskFilter, string> = {
  active: 'Active Tasks',
  due_today: 'Due Today',
  overdue: 'Overdue',
  completed_today: 'Completed Today',
};


type Task = {
  id: string;
  title: string;
  description: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status:
    | 'not_started'
    | 'in_progress'
    | 'waiting'
    | 'completed'
    | 'rejected';
  due_date: string | null;
  parent_task_id: string | null;
};

// Precompute once per render, not inside every row.
const TODAY = new Date().toISOString().split('T')[0];


function isOverdue(task: Task) {
  if (!task.due_date || task.status === 'completed') {
    return false;
  }

  return task.due_date < TODAY;
}

function formatStatus(status: Task['status']) {
  return status.replace('_', ' ').toUpperCase();
}

function formatPriority(priority: Task['priority']) {
  return priority.toUpperCase();
}

// Memoized so a refresh that returns the same list does not re-render every
// row. Before this, renderTask was a new closure per render, which defeated
// memoization and made long lists scroll sluggishly.
const TaskRow = memo(function TaskRow({
  item,
  readonly,
}: {
  item: Task;
  readonly?: boolean;
}) {
  const overdue = isOverdue(item);

  return (
    <AppPress
      style={styles.taskCard}
      onPress={() =>
        nav({
          pathname: '/task-detail',
          // readonly=1 tells task-detail to render the monitoring view: no
          // status buttons, no comment box, no edit affordances.
          params: readonly ? { id: item.id, readonly: '1' } : { id: item.id },
        })
      }
    >
      <View style={styles.taskTop}>
        <Text style={styles.taskTitle}>{item.title}</Text>

        <View style={styles.priorityBadge}>
          <Text style={styles.priorityText}>
            {formatPriority(item.priority)}
          </Text>
        </View>
      </View>

      {item.description ? (
        <Text style={styles.description} numberOfLines={2}>
          {item.description}
        </Text>
      ) : null}

      <View style={styles.taskBottom}>
        <View>
          <Text style={styles.label}>STATUS</Text>

          <Text style={styles.status}>
            {formatStatus(item.status)}
          </Text>
        </View>

        <View style={styles.dueContainer}>
          <Text style={styles.label}>DUE DATE</Text>

          <Text
            style={[styles.dueDate, overdue && styles.overdue]}
          >
            {item.due_date || 'No deadline'}
          </Text>
        </View>
      </View>

      {overdue && (
        <View style={styles.overdueBox}>
          <Text style={styles.overdueText}>OVERDUE</Text>
        </View>
      )}

      <View style={styles.viewTaskRow}>
        <Text style={styles.viewTaskText}>VIEW TASK</Text>

        <Text style={styles.arrow}>›</Text>
      </View>
    </AppPress>
  );
});

export default function TasksScreen() {
  const { filter, readonly } = useLocalSearchParams<{
    filter?: string;
    readonly?: string;
  }>();

  const taskFilter = (
    filter && filter in FILTER_TITLES ? filter : null
  ) as TaskFilter | null;

  // The monitoring list is read-only: tapping a task opens task-detail with
  // every write control suppressed.
  const isMonitoring = readonly === '1';

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Drives the "Company-wide" / "Assigned to you" subtitle.
  const [isCompanyWideScope, setIsCompanyWideScope] = useState(false);

  const loadTasks = useCallback(async () => {
    try {
      // Cached local session read, not an auth-server round-trip.
      const userId = await getMyId();

      if (!userId) {
        setTasks([]);
        return;
      }

      // Director/Super Admin see the WHOLE company; everyone else is restricted
      // to work assigned to them. No RLS change is needed for this - the
      // tasks_select policy already grants those two roles every row, so
      // dropping the assignee filter is all it takes.
      const profile = await getSessionProfile();
      const isCompanyWide =
        profile?.role === 'director' || profile?.role === 'super_admin';

      setIsCompanyWideScope(isCompanyWide);

      let query = supabase
        .from('tasks')
        .select(
          'id, title, description, priority, status, due_date, parent_task_id, assigned_to, completed_at'
        );

      if (!isCompanyWide) {
        query = query.eq('assigned_to', userId);
      }

      // --- filters, mirroring dashboard_counts() in migration 0019 ---------
      switch (taskFilter) {
        case 'active':
          query = query.neq('status', 'completed');
          break;

        case 'due_today':
          query = query.eq('due_date', TODAY).neq('status', 'completed');
          break;

        case 'overdue':
          query = query.lt('due_date', TODAY).neq('status', 'completed');
          break;

        case 'completed_today':
          // 0019 compares against midnight UTC of the current day.
          query = query
            .eq('status', 'completed')
            .gte('completed_at', `${TODAY}T00:00:00Z`);
          break;
      }
      // ----------------------------------------------------------------------

      const { data, error } = await query.order('due_date', {
        ascending: true,
        nullsFirst: false,
      });

      if (error) {
        console.log('Load tasks error:', error.message);
        return;
      }

      setTasks(data ?? []);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [taskFilter]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const refreshTasks = useCallback(async () => {
    setRefreshing(true);
    await loadTasks();
  }, [loadTasks]);

  const renderTask = useCallback(
    ({ item }: { item: Task }) => (
      <TaskRow item={item} readonly={isMonitoring} />
    ),
    [isMonitoring]
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <AppPress style={styles.backButton} onPress={() => goBack()}>
            <Ionicons name="arrow-back" size={22} color="#FFFFFF" />
          </AppPress>

          <View style={styles.headerText}>
            <Text style={styles.title}>
              {taskFilter ? FILTER_TITLES[taskFilter] : 'Tasks'}
            </Text>

            <Text style={styles.subtitle}>
              {taskFilter
                ? isCompanyWideScope
                  ? 'Company-wide'
                  : 'Assigned to you'
                : 'Company Task Management'}
            </Text>
          </View>
        </View>
      </View>

      {loading ? (
        // Skeleton holds the layout instead of a spinner, so the list fades
        // in where the placeholders were instead of popping in from nothing.
        <FlatList
          data={[0, 1, 2, 3, 4]}
          keyExtractor={(item) => `skeleton-${item}`}
          renderItem={() => <SkeletonCard />}
          contentContainerStyle={styles.listContainer}
          scrollEnabled={false}
        />
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={(item) => item.id}
          renderItem={renderTask}
          contentContainerStyle={
            tasks.length === 0
              ? styles.emptyContainer
              : styles.listContainer
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refreshTasks}
            />
          }
          removeClippedSubviews
          maxToRenderPerBatch={10}
          windowSize={7}
          initialNumToRender={8}
          ListEmptyComponent={
            <EmptyState
              icon="clipboard-outline"
              title="No Tasks"
              message="You don't have any assigned tasks yet."
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F5F7',
  },

  header: {
  backgroundColor: '#12233F',
  paddingHorizontal: 20,
  paddingTop: 55,
  paddingBottom: 22,
},

headerRow: {
  flexDirection: 'row',
  alignItems: 'center',
},

backButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#1D3150',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 13,
  },
headerText: {
  flex: 1,
},

title: {
  color: '#FFFFFF',
  fontSize: 26,
  fontWeight: '900',
},

subtitle: {
  color: '#B9C1CC',
  fontSize: 14,
  marginTop: 4,
},

  listContainer: {
    padding: 16,
  },

  taskCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2E6EA',
  },

  taskTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },

  taskTitle: {
    flex: 1,
    color: '#12233F',
    fontSize: 17,
    fontWeight: '800',
    marginRight: 10,
  },

  priorityBadge: {
    backgroundColor: '#FFF1E6',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 6,
  },

  priorityText: {
    color: '#E87516',
    fontSize: 10,
    fontWeight: '900',
  },

  description: {
    color: '#6F7884',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 9,
  },

  taskBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
  },

  label: {
    color: '#9AA2AC',
    fontSize: 9,
    fontWeight: '800',
    marginBottom: 4,
  },

  status: {
    color: '#12233F',
    fontSize: 12,
    fontWeight: '700',
  },

  dueContainer: {
    alignItems: 'flex-end',
  },

  dueDate: {
    color: '#12233F',
    fontSize: 12,
    fontWeight: '700',
  },

  overdue: {
    color: '#D64545',
  },

  overdueBox: {
    backgroundColor: '#FDECEC',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 9,
    alignSelf: 'flex-start',
    marginTop: 12,
  },

  overdueText: {
    color: '#D64545',
    fontSize: 10,
    fontWeight: '900',
  },

  viewTaskRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: 14,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#EEF0F2',
  },

  viewTaskText: {
    color: '#E87516',
    fontSize: 10,
    fontWeight: '900',
  },

  arrow: {
    color: '#E87516',
    fontSize: 22,
    marginLeft: 5,
    lineHeight: 18,
  },

  emptyContainer: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
  },
});