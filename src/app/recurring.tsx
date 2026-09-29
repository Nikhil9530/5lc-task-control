import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Modal, Platform, RefreshControl, SafeAreaView,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { router } from 'expo-router';
import { goBack } from '../../lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { supabase } from '../../lib/supabase';
import { getSessionProfile } from '../../lib/auth';
import { EmployeePicker } from '../../lib/EmployeePicker';
import { COLORS } from '../constants/app';

type Recurring = {
  id: string;
  title: string;
  frequency: string;
  next_run_date: string;
  is_active: boolean;
  assigned_to: string;
};

const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;

export default function RecurringScreen() {
  const [items, setItems] = useState<Recurring[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const [assignees, setAssignees] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [frequency, setFrequency] = useState<string>('weekly');
  const [assignee, setAssignee] = useState('');
  const [startDate, setStartDate] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [showPicker, setShowPicker] = useState(false);

  const load = useCallback(async () => {
    try {
      const me = await getSessionProfile();
      if (!me) {
        Alert.alert('Session Expired', 'Please log in again.');
        router.replace('/');
        return;
      }

      const { data, error } = await supabase
        .from('recurring_tasks')
        .select('id, title, frequency, next_run_date, is_active, assigned_to')
        .order('next_run_date', { ascending: true });

      if (error) {
        // Table may not be created yet (migration 0007).
        console.log('Recurring load error:', error.message);
        setItems([]);
        return;
      }
      setItems(data ?? []);

      // People this user may assign to.
      //
      // Same source of truth as the Create Task picker: this calls
      // assignable_profiles(), which applies can_assign_to(). The old query
      // returned every active profile with no role check, so an Employee
      // could pick a Director here and only discover the rejection on save.
      // Self is now included, which also makes a personal recurring task
      // possible.
      const { data: people } = await supabase.rpc('assignable_profiles');
      setAssignees((people ?? []) as any[]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createRecurring() {
    if (!title.trim() || !assignee) {
      Alert.alert('Missing information', 'Enter a title and select an assignee.');
      return;
    }
    setSaving(true);
    try {
      const me = await getSessionProfile();
      const { error } = await supabase.from('recurring_tasks').insert({
        title: title.trim(),
        assigned_to: assignee,
        assigned_by: me?.id ?? null,
        frequency,
        start_date: startDate,
        next_run_date: startDate,
        is_active: true,
      });

      if (error) {
        Alert.alert('Unable to create', error.message);
        return;
      }

      setShowForm(false);
      setTitle('');
      setAssignee('');
      setFrequency('weekly');
      await load();
      Alert.alert('Recurring task created', 'It will be generated automatically.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(item: Recurring) {
    const { error } = await supabase
      .from('recurring_tasks')
      .update({ is_active: !item.is_active })
      .eq('id', item.id);

    if (error) {
      Alert.alert('Unable to update', error.message);
      return;
    }
    await load();
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => goBack()}>
          <Ionicons name="arrow-back" size={22} color="#FFFFFF" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Recurring Tasks</Text>
          <Text style={styles.headerSubtitle}>Automatic repeat assignments</Text>
        </View>
        <TouchableOpacity style={styles.addButton} onPress={() => setShowForm(true)}>
          <Ionicons name="add" size={22} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={COLORS.orange} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={COLORS.orange}
            />
          }
        >
          {items.length === 0 ? (
            <View style={styles.emptyCard}>
              <Ionicons name="repeat-outline" size={30} color={COLORS.textSoft} />
              <Text style={styles.emptyTitle}>No recurring tasks</Text>
              <Text style={styles.emptyText}>
                Create one for weekly reports, monthly meetings or vendor follow-ups.
              </Text>
            </View>
          ) : (
            items.map((r) => (
              <View key={r.id} style={styles.card}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title} numberOfLines={2}>{r.title}</Text>
                  <Text style={styles.meta}>
                    {r.frequency.toUpperCase()}  •  Next {r.next_run_date}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.toggle, r.is_active && styles.toggleOn]}
                  onPress={() => toggleActive(r)}
                >
                  <Text style={[styles.toggleText, r.is_active && styles.toggleTextOn]}>
                    {r.is_active ? 'ACTIVE' : 'PAUSED'}
                  </Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </ScrollView>
      )}

      <Modal visible={showForm} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New Recurring Task</Text>
              <TouchableOpacity onPress={() => setShowForm(false)}>
                <Ionicons name="close" size={22} color={COLORS.textSoft} />
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>TITLE</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Weekly sales report"
              placeholderTextColor={COLORS.textFaint}
              style={styles.input}
            />

            <Text style={styles.label}>FREQUENCY</Text>
            <View style={styles.chipRow}>
              {FREQUENCIES.map((f) => (
                <TouchableOpacity
                  key={f}
                  style={[styles.chip, frequency === f && styles.chipActive]}
                  onPress={() => setFrequency(f)}
                >
                  <Text style={[styles.chipText, frequency === f && styles.chipTextActive]}>
                    {f.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>FIRST RUN DATE</Text>
            <TouchableOpacity style={styles.input} onPress={() => setShowPicker(true)}>
              <Text style={{ color: COLORS.text, fontSize: 14 }}>{startDate}</Text>
            </TouchableOpacity>

            {showPicker && (
              <DateTimePicker
                value={new Date(`${startDate}T00:00:00`)}
                mode="date"
                display={Platform.OS === 'android' ? 'calendar' : 'default'}
                onChange={(event, selected) => {
                  setShowPicker(false);
                  if (event.type !== 'dismissed' && selected) {
                    const y = selected.getFullYear();
                    const m = String(selected.getMonth() + 1).padStart(2, '0');
                    const d = String(selected.getDate()).padStart(2, '0');
                    setStartDate(`${y}-${m}-${d}`);
                  }
                }}
              />
            )}

            <Text style={styles.label}>ASSIGN TO</Text>
            {/* Searchable dropdown. This was a hand-rolled 160px ScrollView with
                no search field, so a large company meant blind-scrolling a list
                that only showed name + employee id. */}
            <EmployeePicker
              employees={assignees}
              value={assignee}
              onChange={setAssignee}
              emptyMessage="No assignees available."
              style={styles.input}
            />

            <TouchableOpacity
              style={[styles.saveButton, saving && styles.disabled]}
              disabled={saving}
              onPress={createRecurring}
            >
              {saving ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.saveText}>CREATE RECURRING TASK</Text>
              )}
            </TouchableOpacity>
          </View>
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
  content: { padding: 16, paddingBottom: 40 },
  card: {
    backgroundColor: COLORS.card, borderRadius: 14, padding: 15,
    borderWidth: 1, borderColor: COLORS.border, marginBottom: 10,
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  title: { color: COLORS.navy, fontSize: 14, fontWeight: '800' },
  meta: { color: COLORS.textSoft, fontSize: 10, marginTop: 4 },
  toggle: {
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7,
    backgroundColor: '#F0F2F4',
  },
  toggleOn: { backgroundColor: COLORS.greenSoft },
  toggleText: { color: COLORS.textSoft, fontSize: 9, fontWeight: '900' },
  toggleTextOn: { color: COLORS.green },
  emptyCard: {
    marginTop: 40, padding: 28, borderRadius: 16, backgroundColor: COLORS.card,
    borderWidth: 1, borderColor: COLORS.border, alignItems: 'center',
  },
  emptyTitle: { marginTop: 14, color: COLORS.navy, fontSize: 16, fontWeight: '900' },
  emptyText: { marginTop: 7, color: COLORS.textSoft, fontSize: 12, textAlign: 'center' },

  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(18,35,63,0.55)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: COLORS.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, maxHeight: '88%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 8,
  },
  modalTitle: { color: COLORS.navy, fontSize: 17, fontWeight: '900' },
  label: {
    color: COLORS.textFaint, fontSize: 9, fontWeight: '900',
    letterSpacing: 0.8, marginTop: 14, marginBottom: 6,
  },
  input: {
    minHeight: 48, backgroundColor: '#F7F8FA', borderWidth: 1,
    borderColor: '#DCE1E6', borderRadius: 10, paddingHorizontal: 13,
    justifyContent: 'center', color: COLORS.text, fontSize: 14,
  },
  chipRow: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1, height: 42, borderRadius: 9, borderWidth: 1,
    borderColor: '#DCE1E6', backgroundColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center',
  },
  chipActive: { backgroundColor: COLORS.navy, borderColor: COLORS.navy },
  chipText: { color: '#687382', fontSize: 10, fontWeight: '900' },
  chipTextActive: { color: '#FFFFFF' },
  saveButton: {
    height: 52, borderRadius: 10, backgroundColor: COLORS.navy,
    alignItems: 'center', justifyContent: 'center', marginTop: 20,
  },
  saveText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  disabled: { opacity: 0.6 },
});