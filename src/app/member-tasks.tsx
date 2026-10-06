import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Platform,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { getSessionProfile } from '../../lib/auth';
import { goBack, nav } from '../../lib/navigation';
import { supabase } from '../../lib/supabase';
import { AppPress, EmptyState, SkeletonCard } from '../../lib/ui';
import { COLORS, statusColor, statusLabel } from '../constants/app';
import {
  attributionRows,
  withAttribution,
  type PersonRef,
} from '../../lib/taskAttribution';
import {
  CATEGORIES,
  categoriseTask,
  countByCategory,
  type Category,
} from '../../lib/taskCategories';

/**
 * MEMBER TASKS
 *
 * "If I click on any member I should see what I have assigned to him and what
 * is going on."
 *
 * Row visibility is already enforced by RLS (`tasks_select` allows
 * is_self_or_downline(assigned_to) and is_director_or_admin()), so a
 * manager/head sees their downline and a director sees everyone. This screen
 * is the missing window onto that data.
 *
 * Loads the member's tasks in ONE query and filters on the device, so
 * switching tabs is instant instead of re-hitting the network.
 */

type MemberTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  assigned_by: string | null;
  parent_task_id: string | null;
  // The assignee is the member this screen is about, so their name is the
  // page header - but it is still joined here so the card can name the
  // creator and the assigner beside it.
  created_by: string | null;
  assigned_to: string | null;
  creator: PersonRef | null;
  assigner: PersonRef | null;
  assignee: PersonRef | null;
};

type Member = {
  id: string;
  full_name: string;
  employee_id: string;
  role: string;
  department: string | null;
};

type Filter = 'all' | 'given_by_me' | 'open' | 'overdue' | 'completed';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'given_by_me', label: 'Given by me' },
  { key: 'open', label: 'Open' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'completed', label: 'Completed' },
];

function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

const MemberTaskRow = memo(function MemberTaskRow({
  task,
  isOverdue,
  mine,
}: {
  task: MemberTask;
  isOverdue: boolean;
  mine: boolean;
}) {
  const handlePress = useCallback(() => {
    nav({ pathname: '/task-detail', params: { id: task.id } });
  }, [task.id]);

  // The assignee is already this screen's page header, so only the other two
  // lines are drawn. Filtered here rather than inside attributionRows so that
  // helper stays generic for the screens that do show all three.
  const attributionRowsToShow = attributionRows(task).filter(
    (r) => r.label !== 'ASSIGNED TO',
  );

  return (
    <AppPress
      style={styles.taskCard}
      onPress={handlePress}
    >
      <View style={styles.taskTop}>
        <Text style={styles.taskTitle} numberOfLines={2}>
          {task.title}
        </Text>

        <View
          style={[
            styles.statusPill,
            { borderColor: statusColor(task.status) },
          ]}
        >
          <Text
            style={[
              styles.statusPillText,
              { color: statusColor(task.status) },
            ]}
          >
            {statusLabel(task.status).toUpperCase()}
          </Text>
        </View>
      </View>

      <View style={styles.taskMetaRow}>
        <Text
          style={[
            styles.taskMeta,
            isOverdue && { color: COLORS.red, fontWeight: '700' },
          ]}
        >
          {isOverdue ? 'Overdue: ' : 'Due: '}
          {task.due_date ?? 'Not set'}
        </Text>
        <Text style={styles.taskMeta}>{task.priority.toUpperCase()}</Text>
      </View>

      <View style={styles.taskTagRow}>
        {mine && (
          <View style={styles.givenByMeTag}>
            <Ionicons name="person-add" size={11} color={COLORS.orange} />
            <Text style={styles.givenByMeText}>ASSIGNED BY ME</Text>
          </View>
        )}
        {task.parent_task_id && (
          <View style={styles.subTaskTag}>
            <Ionicons
              name="git-branch-outline"
              size={11}
              color={COLORS.navySoft}
            />
            <Text style={styles.subTaskText}>SUB-TASK</Text>
          </View>
        )}
      </View>

      {/* On this screen the assignee is already the page header, so repeating
          "ASSIGNED TO" on every card is pure noise. Only the two lines the
          header cannot tell you - who raised it, and who handed it over -
          are drawn. */}
      {attributionRowsToShow.length > 0 && (
        <View style={styles.attributionBlock}>
          {attributionRowsToShow.map((row) => (
            <View key={row.label} style={styles.attributionRow}>
              <Text style={styles.attributionLabel}>{row.label}</Text>

              <Text style={styles.attributionValue} numberOfLines={1}>
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      )}
    </AppPress>
  );
});

export default function MemberTasksScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();

  const [member, setMember] = useState<Member | null>(null);
  const [tasks, setTasks] = useState<MemberTask[]>([]);
  const [myId, setMyId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  // The standard four relationship categories, same lib and same semantics
  // as tasks.tsx - counted from the VIEWER (myId), so on this screen
  // "Assigned by me" means "of this member's work, the part I handed over".
  // It composes with the tab row below: pick a category AND a tab, and the
  // list is the intersection.
  const [category, setCategory] = useState<Category>('all');

  const load = useCallback(async () => {
    if (!id) return;

    try {
      const me = await getSessionProfile();
      setMyId(me?.id ?? '');

      const [memberResult, tasksResult] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, full_name, employee_id, role, department')
          .eq('id', id)
          .maybeSingle(),
        // Literal, not a template: supabase-js derives the row type from this
        // string, and an interpolated constant is opaque to that parser. The
        // `!<column>` hints pin each of the three joins to its own foreign
        // key - without them PostgREST cannot disambiguate them. The three
        // aliases and hints must match lib/taskAttribution.ts.
        supabase
          .from('tasks')
          .select(
            'id, title, status, priority, due_date, parent_task_id, created_by, assigned_by, assigned_to, creator:profiles!created_by(id, full_name, employee_id), assigner:profiles!assigned_by(id, full_name, employee_id), assignee:profiles!assigned_to(id, full_name, employee_id)'
          )
          .eq('assigned_to', id)
          .order('due_date', { ascending: true, nullsFirst: false }),
      ]);

      if (memberResult.data) setMember(memberResult.data as Member);

      if (tasksResult.error) {
        console.log('Member tasks error:', tasksResult.error.message);
        return;
      }

      // withAttribution narrows the three embedded profiles; see
      // lib/taskAttribution.ts. assigned_by survives it untouched, so the
      // "Given by me" tab and its counter below still work.
      setTasks((tasksResult.data ?? []).map(withAttribution));
    } catch (e) {
      console.log('Member tasks load error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const today = todayIso();

  const isOverdue = (t: MemberTask) =>
    !!t.due_date && t.status !== 'completed' && t.due_date < today;

  // One pass over the same array -> tab switching costs nothing.
  const stats = useMemo(() => {
    let open = 0;
    let overdue = 0;
    let completed = 0;
    let givenByMe = 0;

    for (const t of tasks) {
      if (t.status === 'completed') completed++;
      else open++;
      if (t.due_date && t.status !== 'completed' && t.due_date < today) overdue++;
      if (myId && t.assigned_by === myId) givenByMe++;
    }

    return { total: tasks.length, open, overdue, completed, givenByMe };
  }, [tasks, myId, today]);

  // Chip counts: one pass, same helper as every other screen.
  const categoryCounts = useMemo(
    () => countByCategory(tasks, myId),
    [tasks, myId],
  );

  const visible = useMemo(() => {
    // Tab first...
    let rows: MemberTask[];

    if (filter === 'given_by_me') {
      rows = tasks.filter((t) => !!myId && t.assigned_by === myId);
    } else if (filter === 'open') {
      rows = tasks.filter((t) => t.status !== 'completed');
    } else if (filter === 'overdue') {
      rows = tasks.filter(isOverdue);
    } else if (filter === 'completed') {
      rows = tasks.filter((t) => t.status === 'completed');
    } else {
      rows = tasks;
    }

    // ...then the category, so the two rows compose into one intersection.
    // 'all' short-circuits - it is the default and the common case.
    if (category === 'all') return rows;

    return rows.filter((t) => categoriseTask(t, myId) === category);
  }, [filter, category, tasks, myId, today]);

  const displayName = member?.full_name ?? name ?? 'Member';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <AppPress style={styles.backButton} onPress={() => goBack()}>
          <Ionicons name="arrow-back" size={22} color="#FFFFFF" />
        </AppPress>

        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {member
              ? `${member.employee_id}${member.department ? `  \u2022  ${member.department}` : ''}`
              : 'Assigned work'}
          </Text>
        </View>

        {member && (
          <View style={styles.roleChip}>
            <Text style={styles.roleChipText}>
              {member.role.replace(/_/g, ' ').toUpperCase()}
            </Text>
          </View>
        )}
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={COLORS.orange}
          />
        }
      >
        <View style={styles.statRow}>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{stats.open}</Text>
            <Text style={styles.statLabel}>OPEN</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: COLORS.red }]}>
              {stats.overdue}
            </Text>
            <Text style={styles.statLabel}>OVERDUE</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: COLORS.green }]}>
              {stats.completed}
            </Text>
            <Text style={styles.statLabel}>DONE</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: COLORS.orange }]}>
              {stats.givenByMe}
            </Text>
            <Text style={styles.statLabel}>BY ME</Text>
          </View>
        </View>

        {/* THE FOUR CATEGORIES - the same row tasks.tsx shows, placed above
            the screen's own tabs so the eye meets the shared categories
            first. Counts come from the member's WHOLE list (pre-tab), so a
            chip never shows a number the tab row is about to contradict. */}
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
                  style={[styles.chipText, active && styles.chipTextActive]}
                >
                  {c.label}
                </Text>

                <Text
                  style={[styles.chipCount, active && styles.chipCountActive]}
                >
                  {count}
                </Text>
              </AppPress>
            );
          })}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <AppPress
                key={f.key}
                style={[styles.filterChip, active && styles.filterChipActive]}
                onPress={() => setFilter(f.key)}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    active && styles.filterChipTextActive,
                  ]}
                >
                  {f.label}
                </Text>
              </AppPress>
            );
          })}
        </ScrollView>
        {loading ? (
          <View style={{ gap: 10 }}>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="file-tray-outline"
            title="Nothing here"
            message={`No tasks match this filter for ${displayName}.`}
          />
        ) : (
          visible.map((t) => (
            <MemberTaskRow
              key={t.id}
              task={t}
              isOverdue={isOverdue(t)}
              mine={!!myId && t.assigned_by === myId}
            />
          ))
        )}

        <Text style={styles.footNote}>
          Showing work assigned to {displayName}
          {stats.total > 0 ? `  \u2022  ${stats.total} total` : ''}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    backgroundColor: COLORS.navy,
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 46 : 15,
    paddingBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  backButton: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.10)',
    justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: { color: '#FFFFFF', fontSize: 19, fontWeight: '900' },
  headerSubtitle: { color: '#B9C2CF', fontSize: 12, marginTop: 3 },
  roleChip: {
    backgroundColor: 'rgba(232,117,22,0.18)',
    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5,
  },
  roleChipText: { color: COLORS.orange, fontSize: 10, fontWeight: '800' },
  content: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: COLORS.textSoft, marginTop: 10, fontSize: 13 },

  statRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  statBox: {
    flex: 1, backgroundColor: COLORS.card, borderRadius: 12, paddingVertical: 12,
    alignItems: 'center', borderWidth: 1, borderColor: COLORS.border,
  },
  statValue: { fontSize: 19, fontWeight: '900', color: COLORS.text },
  statLabel: { fontSize: 8, fontWeight: '800', color: COLORS.textFaint, marginTop: 3 },

  filterRow: { gap: 8, paddingBottom: 14 },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.border,
  },
  filterChipActive: { backgroundColor: COLORS.navy, borderColor: COLORS.navy },
  filterChipText: { fontSize: 12, fontWeight: '700', color: COLORS.textSoft },
  filterChipTextActive: { color: '#FFFFFF' },

  // Category chips - same pill geometry as the tabs below and the same
  // navy-active / orange-count treatment as tasks.tsx, so the two rows read
  // as one filter block rather than two competing controls.
  chipBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.card, borderRadius: 20,
    paddingHorizontal: 12, paddingVertical: 7,
  },
  chipActive: { backgroundColor: COLORS.navy, borderColor: COLORS.navy },
  chipText: { color: COLORS.text, fontSize: 12, fontWeight: '700' },
  chipTextActive: { color: '#FFFFFF' },
  chipCount: { color: COLORS.textFaint, fontSize: 11, fontWeight: '900' },
  chipCountActive: { color: COLORS.orange },

  taskCard: {
    backgroundColor: COLORS.card, borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: COLORS.border, marginBottom: 10,
  },
  taskTop: {
    flexDirection: 'row', alignItems: 'flex-start',
    justifyContent: 'space-between', gap: 10,
  },
  taskTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: COLORS.text },
  statusPill: {
    borderWidth: 1, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 3,
  },
  statusPillText: { fontSize: 9, fontWeight: '800' },
  taskMetaRow: {
    flexDirection: 'row', justifyContent: 'space-between', marginTop: 9,
  },
  taskMeta: { fontSize: 11, color: COLORS.textSoft },
  taskTagRow: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  givenByMeTag: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: COLORS.orangeSoft, borderRadius: 20,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  givenByMeText: { fontSize: 9, fontWeight: '800', color: COLORS.orange },
  subTaskTag: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: COLORS.bg, borderRadius: 20,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  subTaskText: { fontSize: 9, fontWeight: '800', color: COLORS.navySoft },

  // Mirrors the block on tasks.tsx: a ruled-off group so the two name lines
  // read as metadata rather than as more tags.
  attributionBlock: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    gap: 6,
  },
  attributionRow: { flexDirection: 'row', alignItems: 'center' },
  attributionLabel: {
    width: 100,
    fontSize: 9,
    fontWeight: '800',
    color: COLORS.textFaint,
  },
  attributionValue: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.text,
  },

  emptyCard: {
    backgroundColor: COLORS.card, borderRadius: 14, padding: 26,
    alignItems: 'center', borderWidth: 1, borderColor: COLORS.border, gap: 8,
  },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: COLORS.text },
  emptyText: { fontSize: 12, color: COLORS.textSoft, textAlign: 'center' },
  footNote: {
    fontSize: 11, color: COLORS.textFaint, textAlign: 'center', marginTop: 12,
  },
});
