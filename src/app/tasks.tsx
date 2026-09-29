import { Ionicons } from '@expo/vector-icons';
import { goBack, nav } from '../../lib/navigation';
import { getMyId, getSessionProfile } from '../../lib/auth';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  attributionRows,
  withAttribution,
  type PersonRef,
} from '../../lib/taskAttribution';
import {
  CATEGORIES,
  categoriseTask,
  countByCategory,
  isOpenTask,
  type Category,
} from '../../lib/taskCategories';

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

// The three category chips live in lib/taskCategories.ts, not here: a route
// file under app/ may only export its default component, so the rule cannot
// live here and stay testable.


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
  created_by: string | null;
  assigned_by: string | null;
  assigned_to: string | null;
  // PostgREST-embedded profile rows for the three keys above. See
  // lib/taskAttribution.ts for why each join needs an explicit hint.
  creator: PersonRef | null;
  assigner: PersonRef | null;
  assignee: PersonRef | null;
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
  // Computed once per render rather than inline in the JSX, so the guard below
  // and the .map below are guaranteed to agree on what will be shown.
  const attribution = attributionRows(item);

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

      {/* CREATED BY / ASSIGNED BY / ASSIGNED TO. Computed once per row
          render, and only the populated lines are drawn - a task with no
          assigner (a legacy row) shows two lines, not three with a blank. */}
      {attribution.length > 0 && (
        <View style={styles.attributionBlock}>
          {attribution.map((row) => (
            <View key={row.label} style={styles.attributionRow}>
              <Text style={styles.attributionLabel}>{row.label}</Text>

              <Text style={styles.attributionValue} numberOfLines={1}>
                {row.value}
              </Text>
            </View>
          ))}
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
  // Which of the three relationship buckets is showing. Drives the chip row.
  const [category, setCategory] = useState<Category>('all');
  // Held in state rather than re-read during render, because categorisation
  // needs the id and getMyId() is async - calling it per render would hand the
  // chip row an empty id on every pass and flash the wrong counts.
  const [myId, setMyId] = useState('');


  const loadTasks = useCallback(async () => {
    try {
      // Cached local session read, not an auth-server round-trip.
      const userId = await getMyId();

      if (!userId) {
        setTasks([]);
        return;
      }

      // Kept for the chip counts and the categorisation below.
      setMyId(userId);

      // Director/Super Admin see the WHOLE company; everyone else is restricted
      // to work assigned to them. No RLS change is needed for this - the
      // tasks_select policy already grants those two roles every row, so
      // dropping the assignee filter is all it takes.
      const profile = await getSessionProfile();
      const isCompanyWide =
        profile?.role === 'director' || profile?.role === 'super_admin';

      setIsCompanyWideScope(isCompanyWide);

      // The select is a literal, not a template with ATTRIBUTION_SELECT
      // spliced in, on purpose: supabase-js types the result from the string
      // itself, and an interpolated constant is opaque to that parser, which
      // makes every downstream setTask/setTasks a type error. The three joins
      // each carry an explicit `!<column>` hint because `tasks` has three
      // separate foreign keys onto `profiles` and PostgREST cannot otherwise
      // tell them apart (PGRST200). Keep the three aliases and the three
      // hints in sync with lib/taskAttribution.ts.
      let query = supabase
        .from('tasks')
        .select(
          'id, title, description, priority, status, due_date, parent_task_id, completed_at, created_by, assigned_by, assigned_to, creator:profiles!created_by(id, full_name, employee_id), assigner:profiles!assigned_by(id, full_name, employee_id), assignee:profiles!assigned_to(id, full_name, employee_id)'
        );

      // SCOPE. This used to be `.eq('assigned_to', userId)`, which was
      // STRICTER than the RLS policy behind it and is why "Assigned by me"
      // could never show anything for a non-director: a task you gave to
      // somebody else has assigned_to = THEM, so the filter threw it away
      // before categorisation ever ran.
      //
      // 0023's tasks_select already grants a signed-in user every row where
      // they are the assignee, the assigner, OR the creator. Matching that
      // here with `.or(...)` means the three chips partition the rows the
      // database was always willing to return - no RLS change, and no wider
      // access than the policy already permits.
      //
      // Director/Super Admin keep the unfiltered company-wide read.
      if (!isCompanyWide) {
        query = query.or(
          `assigned_to.eq.${userId},assigned_by.eq.${userId},created_by.eq.${userId}`,
        );
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

      // withAttribution narrows the three embedded profiles from whatever shape
      // the untyped client hands back to a definite PersonRef | null. See
      // lib/taskAttribution.ts for why that is not optional.
      setTasks((data ?? []).map(withAttribution));
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

  // CATEGORISATION
  //
  // Done on the client, not in the query, for one reason: the four KPI
  // drill-downs arrive here as ?filter=<key> and their predicates are locked
  // to dashboard_counts() in migration 0019 (see the note above). If the chips
  // were pushed into the URL or the query as extra server filters, the list
  // length would stop matching the number on the card that opened it - the
  // exact drift the 0019 comment warns about. Instead the server answers
  // "everything in this KPI bucket", and the chip narrows that set in memory.
  // Tapping a chip is then instant, with no round-trip and no count drift.
  // THE BASE SET
  //
  // My Tasks (no KPI filter) is a to-do list: completed rows are dropped from
  // the base set itself, so no chip - "All" included - can show them. The
  // dashboard's "Completed Today" card is the way back to finished work, and
  // it arrives with its own server bucket, so it is not starved by this.
  const visibleBase = useMemo(
    () => (taskFilter ? tasks : tasks.filter(isOpenTask)),
    [tasks, taskFilter],
  );

  const categoryCounts = useMemo(() => {
    // Counted over the same base set that is listed: the number on
    // "Assigned to me" is the number you will actually see when you tap it.
    const counted = countByCategory(visibleBase, myId);

    return { ...counted, all: visibleBase.length };
  }, [visibleBase, myId]);

  const visibleTasks = useMemo(() => {
    if (category === 'all') return visibleBase;

    // Open work first, relationship second. A completed task never lands here
    // even when its keys would place it in the tapped category.
    return visibleBase.filter(
      (t) => isOpenTask(t) && categoriseTask(t, myId) === category,
    );
  }, [visibleBase, category, myId]);

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

      {/* THE THREE CATEGORIES.
          Present on BOTH entry points - plain "My Tasks" and every one of the
          four KPI drill-downs - because on both the user is asking the same
          question ("is this mine, was it handed to me, or did I hand it
          out?"). The counts sit on the chips so a category with nothing in it
          says so before it is tapped, instead of revealing an empty screen
          afterwards. */}
      <View style={styles.chipBar}>
        {CATEGORIES.map((c) => {
          const active = category === c.key;
          const count = categoryCounts[c.key];

          return (
            <AppPress
              key={c.key}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setCategory(c.key)}
            >
              <Text
                style={[
                  styles.chipText,
                  active && styles.chipTextActive,
                ]}
              >
                {c.label}
              </Text>

              <Text
                style={[
                  styles.chipCount,
                  active && styles.chipCountActive,
                ]}
              >
                {count}
              </Text>
            </AppPress>
          );
        })}
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
          data={visibleTasks}
          keyExtractor={(item) => item.id}
          renderItem={renderTask}
          contentContainerStyle={
            visibleTasks.length === 0
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
              // Named per category, because "no tasks" and "no tasks in THIS
              // category" are different situations. On a chip that legitimately
              // has nothing in it - an employee who has never delegated - the
              // specific label is what stops it reading like a broken screen.
              message={
                category === 'all'
                  ? "You don't have any tasks here yet."
                  : `No tasks in "${CATEGORIES.find((c) => c.key === category)?.label}".`
              }
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

  // The chip bar is a full-bleed strip between the navy header and the list,
  // matching the header's edge-to-edge treatment so the categories read as
  // part of the navigation rather than as a floating control over the cards.
  chipBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E6EA',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#E2E6EA',
    backgroundColor: '#F7F9FA',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },

  chipActive: {
    backgroundColor: '#12233F',
    borderColor: '#12233F',
  },

  chipText: {
    color: '#3C4757',
    fontSize: 12,
    fontWeight: '700',
  },

  chipTextActive: {
    color: '#FFFFFF',
  },

  // The count is deliberately muted on an inactive chip: it is a hint about
  // where the work is, not the headline. On the active chip it goes solid so
  // the current list length reads at a glance.
  chipCount: {
    color: '#9AA2AC',
    fontSize: 11,
    fontWeight: '900',
  },

  chipCountActive: {
    color: '#E87516',
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

  // Attribution sits above the VIEW TASK divider so the card still ends on
  // the same affordance it did before, and the three lines read as one block
  // rather than three competing facts.
  attributionBlock: {
    marginTop: 14,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: '#EEF0F2',
    gap: 7,
  },

  attributionRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  attributionLabel: {
    width: 104,
    color: '#9AA2AC',
    fontSize: 9,
    fontWeight: '800',
  },

  attributionValue: {
    flex: 1,
    color: '#3C4757',
    fontSize: 12,
    fontWeight: '700',
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