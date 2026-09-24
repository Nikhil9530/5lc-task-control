import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Platform, RefreshControl, SafeAreaView,
  ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { getCurrentProfile } from '../../lib/auth';
import { COLORS } from '../constants/app';

type Member = {
  id: string;
  employee_id: string;
  full_name: string;
  role: string;
  department: string | null;
  manager_id: string | null;
  open_tasks: number;
};

export default function TeamScreen() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selfName, setSelfName] = useState('');

  const load = useCallback(async () => {
    try {
      const me = await getCurrentProfile();
      if (!me) {
        Alert.alert('Session Expired', 'Please log in again.');
        router.replace('/');
        return;
      }
      setSelfName(me.full_name || 'Team');

      // Everyone visible to me: directors/admins see all; head/manager see downline.
      const { data: people, error } = await supabase
        .from('profiles')
        .select('id, employee_id, full_name, role, department, manager_id')
        .eq('is_active', true)
        .neq('id', me.id)
        .order('full_name', { ascending: true });

      if (error) {
        Alert.alert('Error', error.message);
        setMembers([]);
        return;
      }

      const list = people ?? [];

      // Scope to the current user's own downline.
      // RLS allows reading the directory (for names) - so the Team screen must
      // filter to hierarchy, not show everyone. Directors see the whole company.
      let scoped = list;
      const isDirectorOrAdmin = ['director', 'super_admin'].includes(me.role);

      if (!isDirectorOrAdmin) {
        const { data: downlineIds, error: dlError } = await supabase.rpc('my_downline');
        if (dlError) {
          console.log('my_downline error:', dlError.message);
        }
        const allowed = new Set<string>(
          (downlineIds ?? []).map((r: any) => r.member_id)
        );
        scoped = list.filter((p: any) => allowed.has(p.id));
      }

      // Open (not completed) task counts per assignee.
      const { data: openTasks } = await supabase
        .from('tasks')
        .select('assigned_to')
        .neq('status', 'completed');

      const countByAssignee: Record<string, number> = {};
      (openTasks ?? []).forEach((t: any) => {
        countByAssignee[t.assigned_to] = (countByAssignee[t.assigned_to] || 0) + 1;
      });

      setMembers(
        scoped.map((p: any) => ({
          ...p,
          open_tasks: countByAssignee[p.id] || 0,
        }))
      );
    } catch (e) {
      console.log('Team load error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#FFFFFF" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>My Team</Text>
          <Text style={styles.headerSubtitle}>People you can see & manage</Text>
        </View>
        <Ionicons name="people-outline" size={22} color={COLORS.orange} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={COLORS.orange} />
          <Text style={styles.loadingText}>Loading team...</Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={COLORS.orange} />
          }
        >
          {members.length === 0 ? (
            <View style={styles.emptyCard}>
              <Ionicons name="people-outline" size={30} color={COLORS.textSoft} />
              <Text style={styles.emptyTitle}>No team members</Text>
              <Text style={styles.emptyText}>
                There is no one in your downline yet.
              </Text>
            </View>
          ) : (
            members.map((m) => (
              <View key={m.id} style={styles.card}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {(m.full_name || 'E').charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.info}>
                  <Text style={styles.name} numberOfLines={1}>{m.full_name}</Text>
                  <Text style={styles.meta}>
                    {m.employee_id}
                    {m.department ? `  •  ${m.department}` : ''}
                  </Text>
                </View>
                <View style={styles.badge}>
                  <Text style={styles.badgeNumber}>{m.open_tasks}</Text>
                  <Text style={styles.badgeLabel}>OPEN</Text>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}
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
  headerTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '900' },
  headerSubtitle: { color: '#B9C2CF', fontSize: 12, marginTop: 3 },
  content: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: COLORS.textSoft, marginTop: 10, fontSize: 13 },
  card: {
    backgroundColor: COLORS.card, borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: COLORS.border,
    flexDirection: 'row', alignItems: 'center', marginBottom: 10,
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.navy,
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  avatarText: { color: '#FFFFFF', fontSize: 16, fontWeight: '900' },
  info: { flex: 1 },
  name: { color: COLORS.navy, fontSize: 14, fontWeight: '800' },
  meta: { color: COLORS.textSoft, fontSize: 10, marginTop: 3 },
  badge: {
    alignItems: 'center', backgroundColor: COLORS.orangeSoft,
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6,
  },
  badgeNumber: { color: COLORS.orangeDark, fontSize: 16, fontWeight: '900' },
  badgeLabel: { color: COLORS.orangeDark, fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },
  emptyCard: {
    marginTop: 40, padding: 28, borderRadius: 16, backgroundColor: COLORS.card,
    borderWidth: 1, borderColor: COLORS.border, alignItems: 'center',
  },
  emptyTitle: { marginTop: 14, color: COLORS.navy, fontSize: 16, fontWeight: '900' },
  emptyText: { marginTop: 7, color: COLORS.textSoft, fontSize: 12, textAlign: 'center' },
});