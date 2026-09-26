import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { getMyId, getSessionProfile } from '../../lib/auth';
import { nav, navReplace } from '../../lib/navigation';
import { registerPushToken } from '../../lib/registerPushToken';
import { supabase } from '../../lib/supabase';
import { AppPress, Skeleton } from '../../lib/ui';

type Counts = {
  active: number;
  due_today: number;
  overdue: number;
  completed_today: number;
  not_started: number;
  in_progress: number;
  waiting: number;
};

// ----------------------------------------------------------------------------
// Last-known KPI values, cached at module scope.
//
// WHY: this screen remounts every time you navigate back to it. Without a
// cache the strip reset to zeros and the numbers visibly "popped in" once the
// network answered - the laggy feel. Seeding state from the cache means the
// strip paints with real numbers on the FIRST frame, then refreshes quietly.
// ----------------------------------------------------------------------------
let cachedCounts: Counts | null = null;
let cachedUserName: string | null = null;
let cachedUserRole: string | null = null;
/** In-flight guard so focus + mount can never double-fire the queries. */
let inFlight: Promise<void> | null = null;

export default function DashboardScreen() {
  // Seeded from cache -> correct on the first paint, no zero-flash.
  const [counts, setCounts] = useState<Counts>(
    cachedCounts ?? {
      active: 0,
      due_today: 0,
      overdue: 0,
      completed_today: 0,
      not_started: 0,
      in_progress: 0,
      waiting: 0,
    }
  );
  const [refreshing, setRefreshing] = useState(false);
  const [userName, setUserName] = useState(cachedUserName ?? 'Super Admin');
  const [userRole, setUserRole] = useState(cachedUserRole ?? '');
  const [hasUnreadNotifications, setHasUnreadNotifications] = useState(false);

  // First network answer still pending AND nothing cached? Then (and only
  // then) show skeleton rows that hold layout. On every return visit the
  // seeded numbers paint instantly and these never appear.
  const [bootstrapping, setBootstrapping] = useState(
    cachedCounts === null
  );

  const pushRegistered = useRef(false);

  useEffect(() => {
    async function registerPush() {
      if (pushRegistered.current) return;

      const userId = await getMyId();
      if (!userId) return;

      pushRegistered.current = true;
      await registerPushToken(userId);
    }

    registerPush();
  }, []);

  const loadDashboard = useCallback(async () => {
    // Collapse concurrent calls (focus + mount racing) into one request.
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        // Shared session identity: ONE local secure-storage read + ONE
        // profiles row for the whole session, promise-deduped across screens.
        // Before this, dashboard -> tasks -> team each fired getUser() (auth
        // server round-trip) + a profiles select in sequence - the laggy feel.
        const today = new Date().toISOString().split('T')[0];

        const [profile, unreadResult, countsResult] = await Promise.all([
          getSessionProfile(),
          (async () => {
            const userId = await getMyId();

            if (!userId) return { count: 0 };

            const unread = await supabase
              .from('notifications')
              .select('id', { count: 'exact', head: true })
              .eq('user_id', userId)
              .eq('is_read', false);

            return { count: unread.count ?? 0 };
          })(),
          // One round-trip for all seven counts instead of seven separate
          // ones. RLS still applies inside the function (security invoker).
          supabase.rpc('dashboard_counts', { p_today: today }),
        ]);

        setUserName(profile?.full_name ?? 'Super Admin');
        setUserRole(profile?.role ?? '');
        setHasUnreadNotifications((unreadResult.count ?? 0) > 0);

        const next = countsResult.data as Counts | null;

        if (next) {
          cachedCounts = next;
          setCounts(next);
        }
      } catch (e) {
        // Never blank the screen on a transient failure - the cached numbers
        // stay on screen and the pull-to-refresh still works.
        console.log('Load dashboard error:', e);
      } finally {
        inFlight = null;
        setBootstrapping(false);
        setRefreshing(false);
      }
    })();

    return inFlight;
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadDashboard();
    }, [loadDashboard])
  );

  // Persist the header values for the next mount.
  useEffect(() => {
    cachedUserName = userName;
  }, [userName]);
  useEffect(() => {
    cachedUserRole = userRole;
  }, [userRole]);

  const {
    active: activeTasks,
    due_today: dueToday,
    overdue,
    completed_today: completedToday,
    not_started: notStarted,
    in_progress: inProgress,
    waiting,
  } = counts;

  async function handleRefresh() {
    setRefreshing(true);
    await loadDashboard();
  }

  function getGreeting() {
    const hour = new Date().getHours();

    if (hour < 12) return 'Good Morning';
    if (hour < 17) return 'Good Afternoon';
    return 'Good Evening';
  }

  function getToday() {
    return new Date().toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  // ---- Role-aware UI -------------------------------------------------------
  // Managers/Heads control their own downline; the Director sees everything.
  // (The database enforces this - these flags only decide what to show.)
  const isManager = ['head', 'manager', 'director', 'super_admin'].includes(userRole);
  const isDirector = ['director', 'super_admin'].includes(userRole);
  const scopeLabel = isDirector ? 'Company-wide' : 'Your team';

const ActionCard = memo(function ActionCard({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <AppPress style={styles.actionCard} onPress={onPress}>
      <View style={styles.actionIcon}>
        <Ionicons name={icon} size={23} color="#FFFFFF" />
      </View>

      <View style={styles.actionBody}>
        <Text style={styles.actionTitle}>{title}</Text>

        <Text style={styles.actionSubtitle}>{subtitle}</Text>
      </View>

      <Ionicons name="chevron-forward" size={18} color="#9AA2AC" />
    </AppPress>
  );
});

const BottomNavItem = memo(function BottomNavItem({
  icon,
  label,
  active,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <AppPress style={styles.navItem} onPress={onPress}>
      <Ionicons
        name={icon}
        size={22}
        color={active ? '#E87516' : '#7B8490'}
      />

      <Text style={active ? styles.navActiveText : styles.navText}>
        {label}
      </Text>
    </AppPress>
  );
});



const KpiCard = memo(function KpiCard({
  icon,
  iconColor,
  iconBg,
  value,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  iconBg: string;
  value: number;
  label: string;
}) {
  return (
    <View style={styles.kpiCard}>
      <View style={[styles.kpiIcon, { backgroundColor: iconBg }]}>
        <Ionicons name={icon} size={23} color={iconColor} />
      </View>

      <Text style={styles.kpiNumber}>{value}</Text>

      <Text style={styles.kpiLabel}>{label}</Text>
    </View>
  );
});

const KpiSkeletonGrid = memo(function KpiSkeletonGrid() {
  return (
    <View style={styles.kpiGrid}>
      {[0, 1, 2, 3].map((key) => (
        <View key={key} style={styles.kpiCard}>
          <Skeleton width={42} height={42} radius={12} />
          <View style={{ height: 10 }} />
          <Skeleton width={52} height={26} />
          <View style={{ height: 6 }} />
          <Skeleton width="80%" height={12} />
        </View>
      ))}
    </View>
  );
});

const StatusRow = memo(function StatusRow({
  dotColor,
  name,
  value,
  last,
}: {
  dotColor: string;
  name: string;
  value: number;
  last?: boolean;
}) {
  return (
    <>
      <View style={styles.statusRow}>
        <View style={styles.statusLeft}>
          <View
            style={[styles.statusDot, { backgroundColor: dotColor }]}
          />

          <Text style={styles.statusName}>{name}</Text>
        </View>

        <Text style={styles.statusValue}>{value}</Text>
      </View>

      {!last && <View style={styles.statusDivider} />}
    </>
  );
});


  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
          />
        }
      >
        {/* HEADER */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <Image
              source={require('../../assets/logo.png')}
              style={styles.logo}
              resizeMode="contain"
            />

            <AppPress
              style={styles.notificationButton}
              onPress={() => nav('/notifications')}
            >
              <Ionicons
                name="notifications-outline"
                size={24}
                color="#FFFFFF"
              />

              {hasUnreadNotifications && (
                <View style={styles.notificationDot} />
              )}
            </AppPress>
          </View>

          <View style={styles.greetingBlock}>
            <Text style={styles.greeting}>
              {getGreeting()}, {userName}
            </Text>

            <Text style={styles.greetingSub}>
              {isDirector
                ? "Here's what's happening across FIVE LASER CUT today."
                : isManager
                  ? "Here's what's happening in your team today."
                  : "Here's your work for today."}
            </Text>

            <Text style={styles.dateText}>
              {getToday()}
            </Text>
          </View>
        </View>

        {/* KPI CARDS - skeleton on cold start only; cached numbers paint instantly */}
        {bootstrapping ? (
          <KpiSkeletonGrid />
        ) : (
          <View style={styles.kpiGrid}>
            <KpiCard
              icon="clipboard-outline"
              iconColor="#17365D"
              iconBg="#EAF1F9"
              value={activeTasks}
              label="Active Tasks"
            />

            <KpiCard
              icon="calendar-outline"
              iconColor="#E87516"
              iconBg="#FFF0E5"
              value={dueToday}
              label="Due Today"
            />

            <KpiCard
              icon="warning-outline"
              iconColor="#D64545"
              iconBg="#FDEBEC"
              value={overdue}
              label="Overdue"
            />

            <KpiCard
              icon="checkmark-circle-outline"
              iconColor="#168653"
              iconBg="#E8F6EF"
              value={completedToday}
              label="Completed Today"
            />
          </View>
        )}

        {/* QUICK ACTIONS - role aware: managers control their own downline only */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            {isManager ? 'Management' : 'My Work'}
          </Text>

          <View style={styles.actionGrid}>
            <ActionCard
              icon="add"
              title="Create Task"
              subtitle={
                isDirector
                  ? 'Assign any work'
                  : isManager
                    ? 'Assign to your team or yourself'
                    : 'Add a task for yourself'
              }
              onPress={() => nav('/create-task')}
            />

            <ActionCard
              icon="list-outline"
              title="My Tasks"
              subtitle="Work assigned to me"
              onPress={() => nav('/tasks')}
            />

            {isManager && (
              <ActionCard
                icon="people-outline"
                title="My Team"
                subtitle={
                  isDirector ? 'Whole company' : 'Your downline'
                }
                onPress={() => nav('/team')}
              />
            )}

            {isManager && (
              <ActionCard
                icon="calendar-outline"
                title="Extensions"
                subtitle="Requests from your team"
                onPress={() => nav('/extensions')}
              />
            )}

            {isManager && (
              <ActionCard
                icon="bar-chart-outline"
                title="Reports"
                subtitle={`${scopeLabel} overview`}
                onPress={() => nav('/reports')}
              />
            )}

            {isManager && (
              <ActionCard
                icon="repeat-outline"
                title="Recurring Tasks"
                subtitle="Automatic repeat work"
                onPress={() => nav('/recurring')}
              />
            )}

            {isDirector && (
              <ActionCard
                icon="person-add-outline"
                title="Members & Hierarchy"
                subtitle="Register people, set reporting"
                onPress={() => nav('/manage-users')}
              />
            )}
          </View>
        </View>

        {/* TASK STATUS */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>
              Task Status
            </Text>

            <AppPress onPress={() => nav('/tasks')}>
              <Text style={styles.viewAll}>View All</Text>
            </AppPress>
          </View>

          <View style={styles.statusCard}>
            <StatusRow
              dotColor="#8D98A5"
              name="Not Started"
              value={notStarted}
            />

            <StatusRow
              dotColor="#E87516"
              name="In Progress"
              value={inProgress}
            />

            <StatusRow
              dotColor="#D9A227"
              name="Waiting"
              value={waiting}
            />

            <StatusRow
              dotColor="#168653"
              name="Completed"
              value={completedToday}
              last
            />
          </View>
        </View>

        {/* ACCOUNTABILITY CARD */}
        <View style={styles.section}>
          <View style={styles.accountabilityCard}>
            <View style={styles.accountabilityIcon}>
              <Ionicons
                name="shield-checkmark-outline"
                size={27}
                color="#E87516"
              />
            </View>

            <View style={styles.accountabilityContent}>
              <Text style={styles.accountabilityTitle}>
                Accountability Control
              </Text>

              <Text style={styles.accountabilityText}>
                Every commitment has an owner and deadline.
                Delays and completions are recorded.
              </Text>
            </View>
          </View>
        </View>

        {/* FOOTER */}
        <View style={styles.footer}>
          <Text style={styles.footerBrand}>
            FIVE LASER CUT
          </Text>

          <Text style={styles.footerText}>
            Simple • Focused • Accountable
          </Text>
        </View>
      </ScrollView>

      {/* BOTTOM NAV - replace so the stack never holds duplicate tabs. Push
          Tasks/Team/Settings twice and the old code stacked two copies; back
          then revealed the same screen again (the "back goes twice" bug). */}
      <View style={styles.bottomNav}>
        <BottomNavItem
          icon="home"
          label="Dashboard"
          active
          onPress={() => navReplace('/dashboard')}
        />

        <BottomNavItem
          icon="clipboard-outline"
          label="Tasks"
          onPress={() => navReplace('/tasks')}
        />

        <BottomNavItem
          icon={isManager ? 'people-outline' : 'notifications-outline'}
          label={isManager ? 'Team' : 'Alerts'}
          onPress={() =>
            navReplace(isManager ? '/team' : '/notifications')
          }
        />

        <BottomNavItem
          icon="settings-outline"
          label="Settings"
          onPress={() => navReplace('/settings')}
        />
      </View>
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
  paddingTop: Platform.OS === 'android' ? 46 :15,
  paddingBottom: 15,
  borderBottomLeftRadius: 25,
  borderBottomRightRadius: 25,
},
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  logo: {
    width: 135,
    height: 44,
  },

  notificationButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.10)',
    justifyContent: 'center',
    alignItems: 'center',
  },

  notificationDot: {
    position: 'absolute',
    top: 9,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#E87516',
  },

  greetingBlock: {
    marginTop: 12,
  },

  greeting: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '900',
  },

  greetingSub: {
    color: '#B9C2CF',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
  },

  dateText: {
    color: '#E87516',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 12,
  },

  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 10,
  },

  kpiCard: {
    width: '48.5%',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E2E6EA',
    minHeight: 132,
  },

  kpiIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },

  kpiNumber: {
    color: '#12233F',
    fontSize: 25,
    fontWeight: '900',
    marginTop: 10,
  },

  kpiLabel: {
    color: '#66717F',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },

  section: {
    paddingHorizontal: 16,
    marginTop: 20,
  },

  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },

  sectionTitle: {
    color: '#12233F',
    fontSize: 17,
    fontWeight: '900',
  },

  viewAll: {
    color: '#E87516',
    fontSize: 11,
    fontWeight: '800',
  },

  actionGrid: {
    gap: 10,
  },

  actionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 13,
    padding: 13,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E6EA',
  },

  actionIcon: {
    width: 42,
    height: 42,
    borderRadius: 11,
    backgroundColor: '#E87516',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },

  actionBody: {
    flex: 1,
  },

  actionTitle: {
    color: '#12233F',
    fontSize: 13,
    fontWeight: '800',
  },

  actionSubtitle: {
    color: '#89929D',
    fontSize: 10,
    marginTop: 3,
  },

  statusCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#E2E6EA',
  },

  statusRow: {
    minHeight: 55,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  statusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  // One dot style instead of four near-identical ones - the colour comes from
  // the StatusRow prop, so adding a status can never mean a missing style.
  statusDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    marginRight: 10,
  },

  statusName: {
    color: '#3E4855',
    fontSize: 12,
    fontWeight: '600',
  },

  statusValue: {
    color: '#12233F',
    fontSize: 13,
    fontWeight: '900',
  },

  statusDivider: {
    height: 1,
    backgroundColor: '#EDF0F2',
  },

  accountabilityCard: {
    backgroundColor: '#12233F',
    borderRadius: 15,
    padding: 17,
    flexDirection: 'row',
    alignItems: 'center',
  },

  accountabilityIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: 'rgba(232,117,22,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 13,
  },

  accountabilityContent: {
    flex: 1,
  },

  accountabilityTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
  },

  accountabilityText: {
    color: '#B9C2CF',
    fontSize: 10,
    lineHeight: 16,
    marginTop: 4,
  },

  footer: {
    alignItems: 'center',
    paddingTop: 26,
    paddingBottom: 105,
  },

  footerBrand: {
    color: '#12233F',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2,
  },

  footerText: {
    color: '#9AA2AC',
    fontSize: 9,
    marginTop: 5,
  },

  bottomNav: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 78,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E2E6EA',
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingBottom: 5,
  },

  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  navText: {
    color: '#7B8490',
    fontSize: 9,
    fontWeight: '600',
    marginTop: 4,
  },

  navActiveText: {
    color: '#E87516',
    fontSize: 9,
    fontWeight: '800',
    marginTop: 4,
  },
});