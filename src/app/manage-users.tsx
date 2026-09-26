import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Modal, Platform, SafeAreaView,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { router } from 'expo-router';
import { goBack, nav } from '../../lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import { supabase, supabaseFunctionsUrl } from '../../lib/supabase';
import { getSessionProfile } from '../../lib/auth';
import { COLORS } from '../constants/app';

type Member = {
  id: string;
  employee_id: string;
  full_name: string;
  email: string;
  role: string;
  department: string | null;
  manager_id: string | null;
  is_active: boolean;
};

const ROLE_OPTIONS = ['employee', 'manager', 'head', 'director', 'super_admin'];

// Calls the manage-user Edge Function with the signed-in user's token.
async function callManageUser(body: Record<string, unknown>) {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Not logged in');

  const res = await fetch(
    `${supabaseFunctionsUrl}/manage-user`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export default function ManageUsersScreen() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [allowed, setAllowed] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('employee');
  const [department, setDepartment] = useState('');
  const [managerId, setManagerId] = useState('');

  // ---- Edit member (role + reporting line) ----
  const [editing, setEditing] = useState<Member | null>(null);
  const [editRole, setEditRole] = useState('employee');
  const [editManagerId, setEditManagerId] = useState('');
  const [editDepartment, setEditDepartment] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const me = await getSessionProfile();
      if (!me) {
        Alert.alert('Session Expired', 'Please log in again.');
        router.replace('/');
        return;
      }
      // Server also enforces this inside the Edge Function - this is only UI.
      if (!['director', 'super_admin'].includes(me.role)) {
        setAllowed(false);
        setLoading(false);
        return;
      }
      setAllowed(true);

      const { data, error } = await supabase
        .from('profiles')
        .select(
          'id, employee_id, full_name, email, role, department, manager_id, is_active'
        )
        .order('full_name', { ascending: true });

      if (error) {
        Alert.alert('Error', error.message);
        return;
      }
      setMembers((data ?? []) as Member[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addMember() {
    if (saving) return;
    if (!employeeId.trim() || !fullName.trim() || !email.trim()) {
      Alert.alert('Missing information', 'Employee ID, full name and email are required.');
      return;
    }
    setSaving(true);
    try {
      const res = await callManageUser({
        action: 'create',
        employee_id: employeeId.trim(),
        full_name: fullName.trim(),
        email: email.trim(),
        role,
        department: department.trim() || null,
        manager_id: managerId || null,
      });

      setShowForm(false);
      setEmployeeId('');
      setFullName('');
      setEmail('');
      setRole('employee');
      setDepartment('');
      setManagerId('');
      await load();

      const lines = [
        `${res.full_name ?? fullName} has been added as ${role}.`,
        '',
        res.invite_email_sent
          ? 'An invite email has been sent.'
          : 'Invite email could not be sent (rate limit).',
        '',
        `Temp password (share privately, once):\n${res.temp_password}`,
        '',
        'The member can set a new password via Forgot Password on the login screen.',
      ];
      Alert.alert('Member Created', lines.join('\n'));
    } catch (e: any) {
      Alert.alert('Unable to create member', String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  function openEdit(m: Member) {
    setEditing(m);
    setEditRole(m.role);
    setEditManagerId(m.manager_id ?? '');
    setEditDepartment(m.department ?? '');
  }

  async function saveEdit() {
    if (!editing || editSaving) return;
    setEditSaving(true);
    try {
      await callManageUser({
        action: 'update',
        user_id: editing.id,
        role: editRole,
        department: editDepartment.trim() || null,
        manager_id: editManagerId || null,
      });
      setEditing(null);
      await load();
      Alert.alert('Saved', 'Role and reporting line updated.');
    } catch (e: any) {
      Alert.alert('Unable to save', String(e?.message ?? e));
    } finally {
      setEditSaving(false);
    }
  }

  async function toggleActive(m: Member) {
    setBusyId(m.id);
    try {
      await callManageUser({
        action: 'set_active',
        user_id: m.id,
        is_active: !m.is_active,
      });
      await load();
    } catch (e: any) {
      Alert.alert('Failed', String(e?.message ?? e));
    } finally {
      setBusyId(null);
    }
  }

  async function resetPassword(m: Member) {
    Alert.alert(
      'Reset Password',
      `Generate a new temp password for ${m.full_name}?\n\nYou will share it privately; they change it in Settings after signing in.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send',
          onPress: async () => {
            setBusyId(m.id);
            try {
              const res = await callManageUser({
                action: 'reset_password',
                user_id: m.id,
              });
              Alert.alert(
                'Password Reset',
                `New temp password:\n\n${res.temp_password}\n\nShare it privately with ${m.full_name}. They should change it in Settings after signing in.`
              );
            } catch (e: any) {
              Alert.alert('Failed', String(e?.message ?? e));
            } finally {
              setBusyId(null);
            }
          },
        },
      ]
    );
  }

  const managers = members.filter((m) =>
    ['head', 'manager', 'director', 'super_admin'].includes(m.role)
  );

  const nameById = new Map(members.map((m) => [m.id, m.full_name]));

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => goBack()}>
          <Ionicons name="arrow-back" size={22} color="#FFFFFF" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Manage Members</Text>
          <Text style={styles.headerSubtitle}>Register & control portal access</Text>
        </View>
        {allowed && (
          <TouchableOpacity style={styles.addButton} onPress={() => setShowForm(true)}>
            <Ionicons name="person-add" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={COLORS.orange} />
        </View>
      ) : !allowed ? (
        <View style={styles.centerState}>
          <Ionicons name="lock-closed-outline" size={34} color={COLORS.textFaint} />
          <Text style={styles.deniedTitle}>Restricted</Text>
          <Text style={styles.deniedText}>
            Only the Director or Super Admin can manage members.
          </Text>
        </View>
      ) : (
        <FlatList
          data={members}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.content}
          renderItem={({ item }) => (
            <View style={[styles.card, !item.is_active && styles.cardInactive]}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {(item.full_name || 'M').charAt(0).toUpperCase()}
                </Text>
              </View>
              <View style={styles.info}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.full_name}
                  {!item.is_active ? '  (inactive)' : ''}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {item.employee_id}  •  {item.role.replace('_', ' ')}
                  {item.department ? `  •  ${item.department}` : ''}
                </Text>
                <Text style={styles.email} numberOfLines={1}>{item.email}</Text>
                <Text style={styles.reportsTo} numberOfLines={1}>
                  Reports to:{' '}
                  {item.manager_id
                    ? (nameById.get(item.manager_id) ?? 'Unknown')
                    : '— not set —'}
                </Text>
              </View>
              <View style={styles.actions}>
                <TouchableOpacity
                  style={styles.actionBtn}
                  disabled={busyId === item.id}
                  // See everything assigned to this person and how far it got.
                  onPress={() =>
                    nav({
                      pathname: '/member-tasks',
                      params: { id: item.id, name: item.full_name },
                    })
                  }
                >
                  <Ionicons name="clipboard-outline" size={17} color={COLORS.green} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.actionBtn}
                  disabled={busyId === item.id}
                  onPress={() => openEdit(item)}
                >
                  <Ionicons name="create-outline" size={17} color={COLORS.navy} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.actionBtn}
                  disabled={busyId === item.id}
                  onPress={() => resetPassword(item)}
                >
                  <Ionicons name="key-outline" size={17} color={COLORS.orangeDark} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.actionBtn}
                  disabled={busyId === item.id}
                  onPress={() => toggleActive(item)}
                >
                  <Ionicons
                    name={item.is_active ? 'lock-closed-outline' : 'checkmark-circle-outline'}
                    size={17}
                    color={item.is_active ? COLORS.red : COLORS.green}
                  />
                </TouchableOpacity>
              </View>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>No members yet</Text>
              <Text style={styles.emptyText}>Tap + to register the first member.</Text>
            </View>
          }
        />
      )}
      {/* EDIT MEMBER MODAL - Director defines role + who reports to whom */}
      <Modal visible={!!editing} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <ScrollView style={styles.modalCard} contentContainerStyle={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editing?.full_name ?? 'Edit Member'}</Text>
              <TouchableOpacity onPress={() => setEditing(null)}>
                <Ionicons name="close" size={22} color={COLORS.textSoft} />
              </TouchableOpacity>
            </View>

            <Text style={styles.editHint}>
              {editing?.employee_id}  •  {editing?.email}
            </Text>

            <Text style={styles.label}>ROLE</Text>
            <View style={styles.chipWrap}>
              {ROLE_OPTIONS.map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.chip, editRole === r && styles.chipActive]}
                  onPress={() => setEditRole(r)}
                >
                  <Text style={[styles.chipText, editRole === r && styles.chipTextActive]}>
                    {r.replace('_', ' ')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>DEPARTMENT</Text>
            <TextInput
              value={editDepartment}
              onChangeText={setEditDepartment}
              placeholder="e.g. Sales, Purchase, Accounts"
              placeholderTextColor={COLORS.textFaint}
              style={styles.input}
            />

            <Text style={styles.label}>REPORTS TO (UPLINE)</Text>
            <View style={styles.managerList}>
              <TouchableOpacity
                style={styles.managerRow}
                onPress={() => setEditManagerId('')}
              >
                <Text style={styles.managerName}>— No manager (direct to Director) —</Text>
                {editManagerId === '' && (
                  <Ionicons name="checkmark-circle" size={20} color={COLORS.orange} />
                )}
              </TouchableOpacity>

              {managers
                .filter((m) => m.id !== editing?.id)
                .map((m) => (
                  <TouchableOpacity
                    key={m.id}
                    style={styles.managerRow}
                    onPress={() => setEditManagerId(m.id)}
                  >
                    <Text style={styles.managerName} numberOfLines={1}>{m.full_name}</Text>
                    <Text style={styles.managerRole}>{m.role.replace('_', ' ')}</Text>
                    {editManagerId === m.id && (
                      <Ionicons name="checkmark-circle" size={20} color={COLORS.orange} />
                    )}
                  </TouchableOpacity>
                ))}
            </View>

            <TouchableOpacity
              style={[styles.saveButton, editSaving && styles.disabled]}
              disabled={editSaving}
              onPress={saveEdit}
            >
              {editSaving ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.saveText}>SAVE CHANGES</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* ADD MEMBER MODAL */}
      <Modal visible={showForm} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <ScrollView style={styles.modalCard} contentContainerStyle={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Member</Text>
              <TouchableOpacity onPress={() => setShowForm(false)}>
                <Ionicons name="close" size={22} color={COLORS.textSoft} />
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>EMPLOYEE ID</Text>
            <TextInput
              value={employeeId}
              onChangeText={setEmployeeId}
              placeholder="e.g. FLC-012"
              autoCapitalize="characters"
              placeholderTextColor={COLORS.textFaint}
              style={styles.input}
            />

            <Text style={styles.label}>FULL NAME</Text>
            <TextInput
              value={fullName}
              onChangeText={setFullName}
              placeholder="Member's full name"
              placeholderTextColor={COLORS.textFaint}
              style={styles.input}
            />

            <Text style={styles.label}>COMPANY EMAIL</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="name@company.com"
              keyboardType="email-address"
              autoCapitalize="none"
              placeholderTextColor={COLORS.textFaint}
              style={styles.input}
            />

            <Text style={styles.label}>ROLE</Text>
            <View style={styles.chipWrap}>
              {ROLE_OPTIONS.map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.chip, role === r && styles.chipActive]}
                  onPress={() => setRole(r)}
                >
                  <Text style={[styles.chipText, role === r && styles.chipTextActive]}>
                    {r.replace('_', ' ')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>DEPARTMENT (OPTIONAL)</Text>
            <TextInput
              value={department}
              onChangeText={setDepartment}
              placeholder="e.g. Sales, Purchase, Accounts"
              placeholderTextColor={COLORS.textFaint}
              style={styles.input}
            />

            <Text style={styles.label}>REPORTS TO (OPTIONAL)</Text>
            {managers.length === 0 ? (
              <Text style={styles.emptyText}>No managers/heads available yet.</Text>
            ) : (
              <View style={styles.managerList}>
                {managers.map((m) => (
                  <TouchableOpacity
                    key={m.id}
                    style={styles.managerRow}
                    onPress={() => setManagerId(managerId === m.id ? '' : m.id)}
                  >
                    <Text style={styles.managerName} numberOfLines={1}>{m.full_name}</Text>
                    <Text style={styles.managerRole}>{m.role.replace('_', ' ')}</Text>
                    {managerId === m.id && (
                      <Ionicons name="checkmark-circle" size={20} color={COLORS.orange} />
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <TouchableOpacity
              style={[styles.saveButton, saving && styles.disabled]}
              disabled={saving}
              onPress={addMember}
            >
              {saving ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.saveText}>CREATE MEMBER & SEND INVITE</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

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
  addButton: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: COLORS.orange,
    justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '900' },
  headerSubtitle: { color: '#B9C2CF', fontSize: 12, marginTop: 3 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  centerState: {
    flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30,
  },
  deniedTitle: { color: COLORS.navy, fontSize: 17, fontWeight: '900', marginTop: 14 },
  deniedText: { color: COLORS.textSoft, fontSize: 12, textAlign: 'center', marginTop: 8 },
  content: { padding: 16, paddingBottom: 40 },
  card: {
    backgroundColor: COLORS.card, borderRadius: 14, padding: 13,
    borderWidth: 1, borderColor: COLORS.border, marginBottom: 10,
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  cardInactive: { opacity: 0.55 },
  avatar: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: COLORS.navy,
    justifyContent: 'center', alignItems: 'center',
  },
  avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  info: { flex: 1 },
  name: { color: COLORS.navy, fontSize: 13, fontWeight: '800' },
  meta: { color: COLORS.textSoft, fontSize: 10, marginTop: 3 },
  email: { color: COLORS.textFaint, fontSize: 10, marginTop: 2 },
  reportsTo: { color: COLORS.orangeDark, fontSize: 10, fontWeight: '700', marginTop: 3 },
  editHint: { color: COLORS.textSoft, fontSize: 11, marginBottom: 4 },
  actions: { flexDirection: 'row', gap: 6 },
  actionBtn: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: '#F4F6F8',
    justifyContent: 'center', alignItems: 'center',
  },
  emptyCard: {
    marginTop: 40, padding: 28, borderRadius: 16, backgroundColor: COLORS.card,
    borderWidth: 1, borderColor: COLORS.border, alignItems: 'center',
  },
  emptyTitle: { marginTop: 14, color: COLORS.navy, fontSize: 16, fontWeight: '900' },
  emptyText: { marginTop: 7, color: COLORS.textSoft, fontSize: 12, textAlign: 'center' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(18,35,63,0.55)' },
  modalCard: {
    backgroundColor: COLORS.card, marginTop: 60,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
  },
  modalContent: { padding: 20, paddingBottom: 40 },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 4,
  },
  modalTitle: { color: COLORS.navy, fontSize: 17, fontWeight: '900' },
  label: {
    color: COLORS.textFaint, fontSize: 9, fontWeight: '900',
    letterSpacing: 0.8, marginTop: 14, marginBottom: 6,
  },
  input: {
    minHeight: 48, backgroundColor: '#F7F8FA', borderWidth: 1,
    borderColor: '#DCE1E6', borderRadius: 10, paddingHorizontal: 13,
    color: COLORS.text, fontSize: 14,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: {
    borderWidth: 1, borderColor: '#DCE1E6', backgroundColor: '#FFFFFF',
    borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8,
  },
  chipActive: { backgroundColor: COLORS.navy, borderColor: COLORS.navy },
  chipText: { color: '#687382', fontSize: 10, fontWeight: '800' },
  chipTextActive: { color: '#FFFFFF', fontWeight: '900' },
  managerList: { maxHeight: 170 },
  managerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F0F2F4',
  },
  managerName: { flex: 1, color: COLORS.navy, fontSize: 13, fontWeight: '700' },
  managerRole: { color: COLORS.textFaint, fontSize: 10 },
  saveButton: {
    height: 52, borderRadius: 10, backgroundColor: COLORS.navy,
    alignItems: 'center', justifyContent: 'center', marginTop: 22,
  },
  saveText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  disabled: { opacity: 0.6 },
});