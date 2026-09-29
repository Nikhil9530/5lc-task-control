import React, { memo, useCallback, useEffect, useState } from 'react';
import {
  Alert, Platform, RefreshControl, SafeAreaView,
  ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { router } from 'expo-router';
import { goBack, nav } from '../../lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { getSessionProfile } from '../../lib/auth';
import { AppPress, Skeleton } from '../../lib/ui';
import { COLORS, STATUS_LABELS, STATUS_COLORS, formatStatusLabel } from '../constants/app';
import {
  attributionRows,
  withAttribution,
  type PersonRef,
} from '../../lib/taskAttribution';

type Stat = { label: string; value: number; color: string };

type OverdueItem = {
  id: string;
  title: string;
  due_date: string;
  priority: string;
  status: string;
  created_by: string | null;
  assigned_by: string | null;
  assigned_to: string | null;
  creator: PersonRef | null;
  assigner: PersonRef | null;
  assignee: PersonRef | null;
};

// The card is one line, so the verbose label is abbreviated. An explicit map
// rather than chained replaces: 'CREATED BY' and 'ASSIGNED BY' overlap enough
// that a substring replace can silently rewrite the wrong one later.
const SHORT_LABELS: Record<string, string> = {
  'CREATED BY': 'By',
  'ASSIGNED BY': 'From',
  'ASSIGNED TO': 'To',
};

const OverdueRow = memo(function OverdueRow({ item }: { item: OverdueItem }) {
  const handlePress = useCallback(() => {
    nav({ pathname: '/task-detail', params: { id: item.id } });
  }, [item.id]);

  // Reports is read as "who is behind this", so attribution gets its own line
  // under the status. Populated lines only, so an unassigned legacy row does
  // not print a dangling separator.
  const attribution = attributionRows(item)
    .map((r) => `${SHORT_LABELS[r.label] ?? r.label}: ${r.value}`)
    .join('  \u2022  ');

  return (
    <AppPress
      style={styles.overdueRow}
      onPress={handlePress}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.overdueTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.overdueMeta}>
          Due {item.due_date}  -  {formatStatusLabel(item.status)}
        </Text>
        {attribution.length > 0 && (
          <Text style={styles.overdueAttribution} numberOfLines={1}>
            {attribution}
          </Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={COLORS.textFaint} />
    </AppPress>
  );
});

function ReportsSkeleton() {
  return (
    <View style={{ gap: 14 }}>
      <View style={styles.summaryRow}>
        <View style={styles.summaryCard}>
          <Skeleton width={80} height={12} />
          <View style={{ height: 10 }} />
          <Skeleton width={50} height={28} />
        </View>
        <View style={styles.summaryCard}>
          <Skeleton width={80} height={12} />
          <View style={{ height: 10 }} />
          <Skeleton width={50} height={28} />
        </View>
      </View>

      <View style={styles.card}>
        <Skeleton width={130} height={18} style={{ marginBottom: 14 }} />
        {[1, 2, 3, 4, 5].map((i) => (
          <View key={i} style={styles.statRow}>
            <Skeleton width={10} height={10} radius={5} style={{ marginRight: 10 }} />
            <Skeleton width="50%" height={14} />
            <View style={{ flex: 1 }} />
            <Skeleton width={24} height={14} />
          </View>
        ))}
      </View>
    </View>
  );
}

export default function ReportsScreen() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<Stat[]>([]);
  const [total, setTotal] = useState(0);
  const [completedAll, setCompletedAll] = useState(0);
  const [overdueList, setOverdueList] = useState<OverdueItem[]>([]);

  const load = useCallback(async () => {
    try {
      const me = await getSessionProfile();
      if (!me) {
        Alert.alert('Session Expired', 'Please log in again.');
        router.replace('/');
        return;
      }
      // RLS scopes these to the viewer's permitted hierarchy automatically.
      const { data: all } = await supabase.from('tasks').select('status, due_date');
      const rows = all ?? [];
      const count = (s: string) => rows.filter((r: any) => r.status === s).length;
      const today = new Date().toISOString().split('T')[0];

      setTotal(rows.length);
      setCompletedAll(count('completed'));
      setStats([
        { label: STATUS_LABELS.not_started, value: count('not_started'), color: STATUS_COLORS.not_started },
        { label: STATUS_LABELS.in_progress, value: count('in_progress'), color: STATUS_COLORS.in_progress },
        { label: STATUS_LABELS.waiting, value: count('waiting'), color: STATUS_COLORS.waiting },
        { label: STATUS_LABELS.completed, value: count('completed'), color: STATUS_COLORS.completed },
        { label: STATUS_LABELS.rejected, value: count('rejected'), color: STATUS_COLORS.rejected },
      ]);

      // Attribution rides along on the same row as the overdue facts, so the
      // "Most Overdue" list can name people without a second request. The
      // count query above is unchanged: it only needs status.
      //
      // Literal select, not a template: supabase-js types the result from the
      // string, so an interpolated constant would make the row `any`-less.
      // The `!<column>` hints are required because `tasks` has three foreign
      // keys onto `profiles`; see lib/taskAttribution.ts.
      const { data: od } = await supabase
        .from('tasks')
        .select(
          'id, title, due_date, priority, status, created_by, assigned_by, assigned_to, creator:profiles!created_by(id, full_name, employee_id), assigner:profiles!assigned_by(id, full_name, employee_id), assignee:profiles!assigned_to(id, full_name, employee_id)'
        )
        .lt('due_date', today)
        .neq('status', 'completed')
        .order('due_date', { ascending: true })
        .limit(8);
      // withAttribution narrows the three embedded profiles; see
      // lib/taskAttribution.ts.
      setOverdueList((od ?? []).map(withAttribution));
    } catch (e) {
      console.log('Reports load error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const completionRate = total > 0 ? Math.round((completedAll / total) * 100) : 0;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <AppPress style={styles.backButton} onPress={() => goBack()}>
          <Ionicons name="arrow-back" size={22} color="#FFFFFF" />
        </AppPress>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Reports</Text>
          <Text style={styles.headerSubtitle}>Performance overview</Text>
        </View>
        <Ionicons name="bar-chart-outline" size={22} color={COLORS.orange} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={COLORS.orange} />}
      >
        {loading ? (
          <ReportsSkeleton />
        ) : (
          <>
            <View style={styles.summaryRow}>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryLabel}>TOTAL TASKS</Text>
                <Text style={styles.summaryValue}>{total}</Text>
              </View>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryLabel}>COMPLETION</Text>
                <Text style={[styles.summaryValue, { color: COLORS.green }]}>{completionRate}%</Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Status Breakdown</Text>
              {stats.map((s) => (
                <View key={s.label} style={styles.statRow}>
                  <View style={[styles.dot, { backgroundColor: s.color }]} />
                  <Text style={styles.statLabel}>{s.label}</Text>
                  <Text style={styles.statValue}>{s.value}</Text>
                </View>
              ))}
            </View>

            <View style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.cardTitle}>Most Overdue</Text>
                <Ionicons name="warning-outline" size={20} color={COLORS.red} />
              </View>
              {overdueList.length === 0 ? (
                <Text style={styles.emptyText}>No overdue tasks. Great work.</Text>
              ) : (
                overdueList.map((t) => (
                  <OverdueRow key={t.id} item={t} />
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    backgroundColor: COLORS.navy, paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 46 : 15, paddingBottom: 20,
    flexDirection: 'row', alignItems: 'center', gap: 14,
  },
  backButton: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.10)',
    justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '900' },
  headerSubtitle: { color: '#B9C2CF', fontSize: 12, marginTop: 3 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  summaryRow: { flexDirection: 'row', gap: 12, marginBottom: 14 },
  summaryCard: {
    flex: 1, backgroundColor: COLORS.card, borderRadius: 14, padding: 18,
    borderWidth: 1, borderColor: COLORS.border,
  },
  summaryLabel: { color: COLORS.textFaint, fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  summaryValue: { color: COLORS.navy, fontSize: 26, fontWeight: '900', marginTop: 6 },
  card: {
    backgroundColor: COLORS.card, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: COLORS.border, marginBottom: 14,
  },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { color: COLORS.navy, fontSize: 15, fontWeight: '900', marginBottom: 8 },
  statRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F0F2F4',
  },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 10 },
  statLabel: { flex: 1, color: COLORS.textSoft, fontSize: 13, fontWeight: '600' },
  statValue: { color: COLORS.navy, fontSize: 15, fontWeight: '900' },
  emptyText: { color: COLORS.textSoft, fontSize: 12, paddingVertical: 8 },
  overdueRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#F0F2F4',
  },
  overdueTitle: { color: COLORS.navy, fontSize: 13, fontWeight: '800' },
  overdueMeta: { color: COLORS.red, fontSize: 10, marginTop: 3 },
  overdueAttribution: {
    color: COLORS.textSoft,
    fontSize: 10,
    fontWeight: '600',
    marginTop: 3,
  },
});