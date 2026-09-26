import React, { memo, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Platform,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { goBack, nav } from '../../lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { getSessionProfile } from '../../lib/auth';
import { AppPress, EmptyState, Skeleton } from '../../lib/ui';
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

const MemberRow = memo(function MemberRow({ member }: { member: Member }) {
  const handlePress = useCallback(() => {
    nav({
      pathname: '/member-tasks',
      params: { id: member.id, name: member.full_name },
    });
  }, [member.id, member.full_name]);

  return (
    <AppPress
      style={styles.card}
      onPress={handlePress}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>
          {(member.full_name || 'E').charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>{member.full_name}</Text>
        <Text style={styles.meta}>
          {member.employee_id}
          {member.department ? `  •  ${member.department}` : ''}
        </Text>
      </View>
      <View style={styles.badge}>
        <Text style={styles.badgeNumber}>{member.open_tasks}</Text>
        <Text style={styles.badgeLabel}>OPEN</Text>
      </View>
      <Ionicons
        name="chevron-forward"
        size={16}
        color={COLORS.textFaint}
      />
    </AppPress>
  );
});

function TeamSkeleton() {
  return (
    <View style={styles.card}>
      <Skeleton width={44} height={44} radius={22} style={{ marginRight: 12 }} />
      <View style={{ flex: 1, gap: 6 }}>
        <Skeleton width="60%" height={14} />
        <Skeleton width="40%" height={10} />
      </View>
      <Skeleton width={48} height={36} radius={10} />
    </View>
  );
}

export default function TeamScreen() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const me = await getSessionProfile();
      if (!me) {
        Alert.alert('Session Expired', 'Please log in again.');
        router.replace('/');
        return;
      }

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

  const renderItem = useCallback(
    ({ item }: { item: Member }) => <MemberRow member={item} />,
    []
  );

  const keyExtractor = useCallback((item: Member) => item.id, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <AppPress style={styles.backButton} onPress={() => goBack()}>
          <Ionicons name="arrow-back" size={22} color="#FFFFFF" />
        </AppPress>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>My Team</Text>
          <Text style={styles.headerSubtitle}>People you can see & manage</Text>
        </View>
        <Ionicons name="people-outline" size={22} color={COLORS.orange} />
      </View>

      {loading ? (
        <View style={styles.content}>
          <TeamSkeleton />
          <TeamSkeleton />
          <TeamSkeleton />
          <TeamSkeleton />
        </View>
      ) : (
        <FlatList
          data={members}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews={Platform.OS !== 'web'}
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
          ListEmptyComponent={
            <EmptyState
              icon="people-outline"
              title="No team members"
              message="There is no one in your downline yet."
            />
          }
        />
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
});