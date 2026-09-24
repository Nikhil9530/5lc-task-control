import React, { useEffect, useState } from 'react';
import { registerPushToken } from '../../lib/registerPushToken';
import {
  Image,
  Platform,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  router,
  useFocusEffect,
} from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';

export default function DashboardScreen() {
  const [activeTasks, setActiveTasks] = useState(0);
  const [dueToday, setDueToday] = useState(0);
  const [overdue, setOverdue] = useState(0);
  const [completedToday, setCompletedToday] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [userName, setUserName] = useState('Super Admin');
  const [userRole, setUserRole] = useState('');
  const [notStarted, setNotStarted] = useState(0);
  const [inProgress, setInProgress] = useState(0);
  const [waiting, setWaiting] = useState(0);
  const [hasUnreadNotifications, setHasUnreadNotifications] =
  useState(false);

  useFocusEffect(
  React.useCallback(() => {
    loadDashboard();
  }, [])
);

  async function loadDashboard() {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        await registerPushToken(user.id);
        
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name, role')
          .eq('id', user.id)
          .single();

        if (profile?.full_name) {
          setUserName(profile.full_name);
        }
        setUserRole(profile?.role ?? '');

        const { count: unreadCount } = await supabase
    .from('notifications')
    .select('*', {
      count: 'exact',
      head: true,
    })
    .eq('user_id', user.id)
    .eq('is_read', false);

  setHasUnreadNotifications(
    (unreadCount ?? 0) > 0
  );
      }

      // RLS already scopes rows to what this user is allowed to see,
      // so these counts are automatically role-aware (employee -> own,
      // manager -> downline, director -> company-wide).
      const today = new Date().toISOString().split('T')[0];

      const count = async (build: (q: any) => any) => {
        const { count: c } = await build(
          supabase.from('tasks').select('*', { count: 'exact', head: true })
        );
        return c ?? 0;
      };

      const [active, due, late, completed, ns, ip, wt] = await Promise.all([
        count((q) => q.neq('status', 'completed')),
        count((q) => q.eq('due_date', today).neq('status', 'completed')),
        count((q) => q.lt('due_date', today).neq('status', 'completed')),
        count((q) => q.eq('status', 'completed').gte('completed_at', `${today}T00:00:00`)),
        count((q) => q.eq('status', 'not_started')),
        count((q) => q.eq('status', 'in_progress')),
        count((q) => q.eq('status', 'waiting')),
      ]);

      setActiveTasks(active);
      setDueToday(due);
      setOverdue(late);
      setCompletedToday(completed);
      setNotStarted(ns);
      setInProgress(ip);
      setWaiting(wt);
    } finally {
      setRefreshing(false);
    }
  }

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

            <TouchableOpacity
  style={styles.notificationButton}
  activeOpacity={0.8}
  onPress={() => router.push('/notifications')}
>
  <Ionicons
    name="notifications-outline"
    size={24}
    color="#FFFFFF"
  />

  {hasUnreadNotifications && (
  <View style={styles.notificationDot} />
)}
</TouchableOpacity>
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

        {/* KPI CARDS */}
        <View style={styles.kpiGrid}>
          <View style={styles.kpiCard}>
            <View style={styles.kpiIconBlue}>
              <Ionicons
                name="clipboard-outline"
                size={23}
                color="#17365D"
              />
            </View>

            <Text style={styles.kpiNumber}>
              {activeTasks}
            </Text>

            <Text style={styles.kpiLabel}>
              Active Tasks
            </Text>
          </View>

          <View style={styles.kpiCard}>
            <View style={styles.kpiIconOrange}>
              <Ionicons
                name="calendar-outline"
                size={23}
                color="#E87516"
              />
            </View>

            <Text style={styles.kpiNumber}>
              {dueToday}
            </Text>

            <Text style={styles.kpiLabel}>
              Due Today
            </Text>
          </View>

          <View style={styles.kpiCard}>
            <View style={styles.kpiIconRed}>
              <Ionicons
                name="warning-outline"
                size={23}
                color="#D64545"
              />
            </View>

            <Text style={styles.kpiNumber}>
              {overdue}
            </Text>

            <Text style={styles.kpiLabel}>
              Overdue
            </Text>
          </View>

          <View style={styles.kpiCard}>
            <View style={styles.kpiIconGreen}>
              <Ionicons
                name="checkmark-circle-outline"
                size={23}
                color="#168653"
              />
            </View>

            <Text style={styles.kpiNumber}>
              {completedToday}
            </Text>

            <Text style={styles.kpiLabel}>
              Completed Today
            </Text>
          </View>
        </View>

        {/* QUICK ACTIONS - role aware: managers control their own downline only */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            {isManager ? 'Management' : 'My Work'}
          </Text>

          <View style={styles.actionGrid}>
            <TouchableOpacity
              style={styles.actionCard}
              activeOpacity={0.8}
              onPress={() => router.push('/create-task')}
            >
              <View style={styles.actionIcon}>
                <Ionicons name="add" size={25} color="#FFFFFF" />
              </View>

              <View>
                <Text style={styles.actionTitle}>Create Task</Text>

                <Text style={styles.actionSubtitle}>
                  {isDirector
                    ? 'Assign any work'
                    : isManager
                      ? 'Assign to your team or yourself'
                      : 'Add a task for yourself'}
                </Text>
              </View>

              <Ionicons name="chevron-forward" size={18} color="#9AA2AC" />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionCard}
              activeOpacity={0.8}
              onPress={() => router.push('/tasks')}
            >
              <View style={styles.actionIcon}>
                <Ionicons name="list-outline" size={23} color="#FFFFFF" />
              </View>

              <View>
                <Text style={styles.actionTitle}>My Tasks</Text>

                <Text style={styles.actionSubtitle}>Work assigned to me</Text>
              </View>

              <Ionicons name="chevron-forward" size={18} color="#9AA2AC" />
            </TouchableOpacity>

            {isManager && (
              <TouchableOpacity
                style={styles.actionCard}
                activeOpacity={0.8}
                onPress={() => router.push('/team')}
              >
                <View style={styles.actionIcon}>
                  <Ionicons name="people-outline" size={23} color="#FFFFFF" />
                </View>

                <View>
                  <Text style={styles.actionTitle}>My Team</Text>

                  <Text style={styles.actionSubtitle}>
                    {isDirector ? 'Whole company' : 'Your downline'}
                  </Text>
                </View>

                <Ionicons name="chevron-forward" size={18} color="#9AA2AC" />
              </TouchableOpacity>
            )}

            {isManager && (
              <TouchableOpacity
                style={styles.actionCard}
                activeOpacity={0.8}
                onPress={() => router.push('/extensions')}
              >
                <View style={styles.actionIcon}>
                  <Ionicons name="calendar-outline" size={23} color="#FFFFFF" />
                </View>

                <View>
                  <Text style={styles.actionTitle}>Extensions</Text>

                  <Text style={styles.actionSubtitle}>
                    Requests from your team
                  </Text>
                </View>

                <Ionicons name="chevron-forward" size={18} color="#9AA2AC" />
              </TouchableOpacity>
            )}

            {isManager && (
              <TouchableOpacity
                style={styles.actionCard}
                activeOpacity={0.8}
                onPress={() => router.push('/reports')}
              >
                <View style={styles.actionIcon}>
                  <Ionicons name="bar-chart-outline" size={23} color="#FFFFFF" />
                </View>

                <View>
                  <Text style={styles.actionTitle}>Reports</Text>

                  <Text style={styles.actionSubtitle}>{scopeLabel} overview</Text>
                </View>

                <Ionicons name="chevron-forward" size={18} color="#9AA2AC" />
              </TouchableOpacity>
            )}

            {isManager && (
              <TouchableOpacity
                style={styles.actionCard}
                activeOpacity={0.8}
                onPress={() => router.push('/recurring')}
              >
                <View style={styles.actionIcon}>
                  <Ionicons name="repeat-outline" size={23} color="#FFFFFF" />
                </View>

                <View>
                  <Text style={styles.actionTitle}>Recurring Tasks</Text>

                  <Text style={styles.actionSubtitle}>
                    Automatic repeat work
                  </Text>
                </View>

                <Ionicons name="chevron-forward" size={18} color="#9AA2AC" />
              </TouchableOpacity>
            )}

            {isDirector && (
              <TouchableOpacity
                style={styles.actionCard}
                activeOpacity={0.8}
                onPress={() => router.push('/manage-users')}
              >
                <View style={styles.actionIcon}>
                  <Ionicons name="person-add-outline" size={23} color="#FFFFFF" />
                </View>

                <View>
                  <Text style={styles.actionTitle}>Members & Hierarchy</Text>

                  <Text style={styles.actionSubtitle}>
                    Register people, set reporting
                  </Text>
                </View>

                <Ionicons name="chevron-forward" size={18} color="#9AA2AC" />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* TASK STATUS */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>
              Task Status
            </Text>

            <TouchableOpacity
              onPress={() => router.push('/tasks')}
            >
              <Text style={styles.viewAll}>
                View All
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.statusCard}>
            <View style={styles.statusRow}>
              <View style={styles.statusLeft}>
                <View style={styles.statusDotNotStarted} />

                <Text style={styles.statusName}>
                  Not Started
                </Text>
              </View>

              <Text style={styles.statusValue}>
                {notStarted}
              </Text>
            </View>

            <View style={styles.statusDivider} />

            <View style={styles.statusRow}>
              <View style={styles.statusLeft}>
                <View style={styles.statusDotProgress} />

                <Text style={styles.statusName}>
                  In Progress
                </Text>
              </View>

              <Text style={styles.statusValue}>
                {inProgress}
              </Text>
            </View>

            <View style={styles.statusDivider} />

            <View style={styles.statusRow}>
              <View style={styles.statusLeft}>
                <View style={styles.statusDotWaiting} />

                <Text style={styles.statusName}>
                  Waiting
                </Text>
              </View>

              <Text style={styles.statusValue}>
                {waiting}
              </Text>
            </View>

            <View style={styles.statusDivider} />

            <View style={styles.statusRow}>
              <View style={styles.statusLeft}>
                <View style={styles.statusDotCompleted} />

                <Text style={styles.statusName}>
                  Completed
                </Text>
              </View>

              <Text style={styles.statusValue}>
                {completedToday}
              </Text>
            </View>
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
            Simple â€¢ Focused â€¢ Accountable
          </Text>
        </View>
      </ScrollView>

      {/* BOTTOM NAV */}
      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => router.replace('/dashboard')}
        >
          <Ionicons
            name="home"
            size={22}
            color="#E87516"
          />

          <Text style={styles.navActiveText}>
            Dashboard
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => router.push('/tasks')}
        >
          <Ionicons
            name="clipboard-outline"
            size={22}
            color="#7B8490"
          />

          <Text style={styles.navText}>
            Tasks
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => router.push(isManager ? '/team' : '/notifications')}
        >
          <Ionicons
            name={isManager ? 'people-outline' : 'notifications-outline'}
            size={22}
            color="#7B8490"
          />

          <Text style={styles.navText}>
            {isManager ? 'Team' : 'Alerts'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => router.push('/settings')}
        >
          <Ionicons
            name="settings-outline"
            size={22}
            color="#7B8490"
          />

          <Text style={styles.navText}>
            Settings
          </Text>
        </TouchableOpacity>
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

  kpiIconBlue: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: '#EAF1F9',
    justifyContent: 'center',
    alignItems: 'center',
  },

  kpiIconOrange: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: '#FFF0E5',
    justifyContent: 'center',
    alignItems: 'center',
  },

  kpiIconRed: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: '#FDEBEC',
    justifyContent: 'center',
    alignItems: 'center',
  },

  kpiIconGreen: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: '#E8F6EF',
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

  statusDotNotStarted: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#8D98A5',
    marginRight: 10,
  },

  statusDotProgress: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#E87516',
    marginRight: 10,
  },

  statusDotWaiting: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#D9A227',
    marginRight: 10,
  },

  statusDotCompleted: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#168653',
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
