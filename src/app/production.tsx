import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AppPress, EmptyState } from '../../lib/ui';
import {
  availableMonths,
  buildReport,
  formatMonth,
  loadProductionData,
  type ProductionData,
  type ProductionDepartment,
} from '../../lib/production';
import { navReplace } from '../../lib/navigation';
import { COLORS } from '../constants/app';

const DEPARTMENTS: { id: ProductionDepartment; title: string; icon: keyof typeof Ionicons.glyphMap; color: string; subtitle: string }[] = [
  { id: 'laser', title: 'Laser', icon: 'flash-outline', color: '#D64545', subtitle: 'Live machine breakdown from Excel' },
  { id: 'bending', title: 'Bending', icon: 'git-compare-outline', color: '#D98A22', subtitle: 'B-1 · B-2 · B-3/4' },
  { id: 'fabrication', title: 'Fabrication', icon: 'construct-outline', color: '#344258', subtitle: 'Mahindra · Metso Machine · Mesto Station' },
];

export default function ProductionScreen() {
  const [data, setData] = useState<ProductionData | null>(null);
  const [department, setDepartment] = useState<ProductionDepartment | null>(null);
  const [month, setMonth] = useState('');
  const [view, setView] = useState<'overview' | 'monthly'>('overview');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true); else setLoading(true);
    try {
      const next = await loadProductionData();
      const months = availableMonths(next);
      setData(next);
      setMonth((current) => months.includes(current) ? current : months[months.length - 1] ?? '');
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load production data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const report = useMemo(
    () => data && department && month ? buildReport(data, department, month) : null,
    [data, department, month],
  );
  const selectedDepartment = DEPARTMENTS.find((item) => item.id === department) ?? null;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>{selectedDepartment ? selectedDepartment.title : 'Production'}</Text>
          <Text style={styles.headerSubtitle}>
            {report?.asOf ? `Data as of ${report.asOf}` : 'Read-only production reporting'}
          </Text>
        </View>
        {department && (
          <AppPress style={styles.changeButton} onPress={() => { setDepartment(null); setView('overview'); }}>
            <Text style={styles.changeButtonText}>CHANGE</Text>
          </AppPress>
        )}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={COLORS.orange} size="large" /></View>
      ) : error ? (
        <View style={styles.center}><EmptyState icon="cloud-offline-outline" title="Production unavailable" message={error} /></View>
      ) : !department ? (
        <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} />}>
          <Text style={styles.sectionTitle}>Select department</Text>
          {DEPARTMENTS.map((item) => {
            const latest = data && month ? buildReport(data, item.id, month).metrics[0] : null;
            return (
              <AppPress key={item.id} style={[styles.departmentCard, { borderLeftColor: item.color }]} onPress={() => setDepartment(item.id)}>
                <View style={[styles.departmentIcon, { backgroundColor: `${item.color}18` }]}>
                  <Ionicons name={item.icon} size={23} color={item.color} />
                </View>
                <View style={styles.departmentCopy}>
                  <Text style={styles.departmentTitle}>{item.title}</Text>
                  <Text style={styles.departmentSubtitle}>{item.subtitle}</Text>
                </View>
                <View style={styles.departmentValue}>
                  <Text style={styles.departmentValueText}>{latest?.value ?? '—'}</Text>
                  <Ionicons name="chevron-forward" size={18} color={COLORS.textFaint} />
                </View>
              </AppPress>
            );
          })}
          {!month && <EmptyState icon="document-outline" title="No production data yet" message="Upload an approved monthly Excel file to the production storage bucket." />}
        </ScrollView>
      ) : report && selectedDepartment ? (
        <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} />}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.monthRow}>
            {report.months.map((item) => (
              <AppPress key={item} style={[styles.monthChip, item === month && { backgroundColor: selectedDepartment.color, borderColor: selectedDepartment.color }]} onPress={() => setMonth(item)}>
                <Text style={[styles.monthChipText, item === month && styles.monthChipTextActive]}>{formatMonth(item)}</Text>
              </AppPress>
            ))}
          </ScrollView>
          <View style={styles.tabRow}>
            <AppPress style={[styles.tab, view === 'overview' && { borderBottomColor: selectedDepartment.color }]} onPress={() => setView('overview')}><Text style={[styles.tabText, view === 'overview' && styles.tabTextActive]}>Overview</Text></AppPress>
            <AppPress style={[styles.tab, view === 'monthly' && { borderBottomColor: selectedDepartment.color }]} onPress={() => setView('monthly')}><Text style={[styles.tabText, view === 'monthly' && styles.tabTextActive]}>Monthly</Text></AppPress>
          </View>
          {view === 'overview' ? <Overview report={report} color={selectedDepartment.color} /> : <Monthly report={report} color={selectedDepartment.color} />}
        </ScrollView>
      ) : null}

      <View style={styles.bottomNav}>
        <Nav icon="home-outline" label="Dashboard" onPress={() => navReplace('/dashboard')} />
        <Nav icon="analytics" label="Production" active />
        <Nav icon="people-outline" label="Team" onPress={() => navReplace('/team')} />
        <Nav icon="settings-outline" label="Settings" onPress={() => navReplace('/settings')} />
      </View>
    </SafeAreaView>
  );
}

function Overview({ report, color }: { report: NonNullable<ReturnType<typeof buildReport>>; color: string }) {
  const peak = Math.max(...report.breakdown.map((item) => item.primary), 1);
  return <>
    <View style={styles.metricGrid}>{report.metrics.map((metric) => <View key={metric.label} style={styles.metricCard}><Text style={styles.metricLabel}>{metric.label}</Text><Text style={[styles.metricValue, { color }]}>{metric.value}</Text><Text style={styles.metricDetail}>{metric.detail}</Text></View>)}</View>
    <View style={styles.card}><Text style={styles.cardTitle}>{report.department === 'bending' ? 'Per-machine strokes' : 'Weight by machine / station'}</Text><Text style={styles.cardSubtitle}>Month to date · calculated with legacy dashboard rules</Text>
      {report.breakdown.map((item) => <View key={item.name} style={styles.breakdownRow}><Text style={styles.breakdownName}>{item.name}</Text><View style={styles.barTrack}><View style={[styles.barFill, { width: `${Math.max(3, item.primary / peak * 100)}%`, backgroundColor: color }]} /></View><Text style={styles.breakdownValue}>{new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(item.primary)}</Text></View>)}
    </View>
    <View style={styles.card}><Text style={styles.cardTitle}>{report.department === 'bending' ? 'Daily strokes' : 'Daily weight'}</Text><Text style={styles.cardSubtitle}>Latest 14 recorded days</Text>
      {report.daily.slice(-14).map((item) => <View key={item.date} style={styles.dailyRow}><Text style={styles.dailyDate}>{item.date.slice(5)}</Text><Text style={styles.dailyValue}>{new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(item.value)}</Text></View>)}
    </View>
  </>;
}

function Monthly({ report, color }: { report: NonNullable<ReturnType<typeof buildReport>>; color: string }) {
  const latest = report.monthly[report.monthly.length - 1];
  const previous = report.monthly[report.monthly.length - 2];
  if (!latest || !previous) return <EmptyState icon="calendar-outline" title="Monthly comparison needs two months" message="Historical dashboard data will appear here after it is ingested." />;
  const labels = Object.keys(latest.values).slice(0, 6);
  return <View style={styles.card}><Text style={styles.cardTitle}>Month-over-month</Text><Text style={styles.cardSubtitle}>{formatMonth(latest.month)} vs {formatMonth(previous.month)}</Text>
    {labels.map((label) => {
      const current = latest.values[label] ?? 0; const before = previous.values[label] ?? 0;
      const change = before ? (current - before) / before * 100 : 0;
      return <View key={label} style={styles.monthlyRow}><Text style={styles.monthlyLabel}>{label}</Text><View><Text style={[styles.monthlyCurrent, { color }]}>{new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(current)}</Text><Text style={[styles.monthlyDelta, { color: change <= 0 ? COLORS.green : COLORS.red }]}>{change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}%</Text></View></View>;
    })}
  </View>;
}

function Nav({ icon, label, active, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; active?: boolean; onPress?: () => void }) {
  return <AppPress style={styles.navItem} onPress={onPress}><Ionicons name={icon} size={21} color={active ? COLORS.orange : COLORS.textFaint} /><Text style={[styles.navText, active && styles.navTextActive]}>{label}</Text></AppPress>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg }, center: { flex: 1, justifyContent: 'center', padding: 22 },
  header: { backgroundColor: COLORS.navy, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { color: '#fff', fontSize: 24, fontWeight: '900' }, headerSubtitle: { color: '#BBC5D1', fontSize: 12, marginTop: 4 },
  changeButton: { borderWidth: 1, borderColor: '#6A7890', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 }, changeButtonText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: .7 },
  content: { padding: 16, paddingBottom: 92 }, sectionTitle: { color: COLORS.navy, fontSize: 14, fontWeight: '900', marginBottom: 12 },
  departmentCard: { minHeight: 90, backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.border, borderLeftWidth: 4, borderRadius: 14, padding: 14, marginBottom: 11, flexDirection: 'row', alignItems: 'center' },
  departmentIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, departmentCopy: { flex: 1 }, departmentTitle: { color: COLORS.navy, fontWeight: '900', fontSize: 16 }, departmentSubtitle: { color: COLORS.textSoft, fontSize: 11, marginTop: 4 }, departmentValue: { alignItems: 'flex-end', gap: 3 }, departmentValueText: { color: COLORS.navy, fontWeight: '800', fontSize: 13 },
  monthRow: { gap: 8, paddingBottom: 13 }, monthChip: { borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.card, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 }, monthChipText: { fontSize: 11, color: COLORS.textSoft, fontWeight: '700' }, monthChipTextActive: { color: '#fff' },
  tabRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: COLORS.border, marginBottom: 14 }, tab: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 3, borderBottomColor: 'transparent' }, tabText: { color: COLORS.textSoft, fontSize: 13, fontWeight: '700' }, tabTextActive: { color: COLORS.navy },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginBottom: 13 }, metricCard: { width: '48.5%', backgroundColor: COLORS.card, borderRadius: 13, borderWidth: 1, borderColor: COLORS.border, padding: 12 }, metricLabel: { color: COLORS.textSoft, fontSize: 10, fontWeight: '800', textTransform: 'uppercase' }, metricValue: { fontSize: 19, fontWeight: '900', marginTop: 7 }, metricDetail: { color: COLORS.textFaint, fontSize: 10, marginTop: 5, lineHeight: 13 },
  card: { backgroundColor: COLORS.card, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, padding: 14, marginBottom: 12 }, cardTitle: { color: COLORS.navy, fontSize: 14, fontWeight: '900' }, cardSubtitle: { color: COLORS.textSoft, fontSize: 10, marginTop: 4, marginBottom: 13 },
  breakdownRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }, breakdownName: { width: 82, color: COLORS.text, fontSize: 11, fontWeight: '700' }, barTrack: { flex: 1, height: 7, borderRadius: 5, overflow: 'hidden', backgroundColor: '#EEF1F4' }, barFill: { height: 7, borderRadius: 5 }, breakdownValue: { width: 54, textAlign: 'right', color: COLORS.navy, fontSize: 11, fontWeight: '800' },
  dailyRow: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#EEF1F4', paddingVertical: 8 }, dailyDate: { color: COLORS.textSoft, fontSize: 11 }, dailyValue: { color: COLORS.navy, fontSize: 11, fontWeight: '800' },
  monthlyRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#EEF1F4' }, monthlyLabel: { color: COLORS.text, fontSize: 12, maxWidth: '65%' }, monthlyCurrent: { fontSize: 13, fontWeight: '900', textAlign: 'right' }, monthlyDelta: { fontSize: 10, fontWeight: '800', marginTop: 3, textAlign: 'right' },
  bottomNav: { height: 66, borderTopWidth: 1, borderTopColor: COLORS.border, backgroundColor: '#fff', flexDirection: 'row', justifyContent: 'space-around', paddingTop: 8 }, navItem: { alignItems: 'center', minWidth: 66, gap: 3 }, navText: { color: COLORS.textFaint, fontSize: 9, fontWeight: '700' }, navTextActive: { color: COLORS.orange },
});
