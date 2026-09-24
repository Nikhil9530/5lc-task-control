import React, { useEffect, useState } from 'react';
import {
  Alert,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import DateTimePicker from '@react-native-community/datetimepicker';
import { supabase } from '../../lib/supabase';

export default function CreateTaskScreen() {
  // When opened from a task as "delegate", this is the parent task id.
  const { parentTaskId, parentTitle } = useLocalSearchParams<{
    parentTaskId?: string;
    parentTitle?: string;
  }>();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [showDueDatePicker, setShowDueDatePicker] = useState(false);

  const [selectedAssignee, setSelectedAssignee] = useState('');
  const [assignees, setAssignees] = useState<any[]>([]);
  const [currentProfile, setCurrentProfile] = useState<any>(null);
  const [loadingAssignees, setLoadingAssignees] = useState(true);
  const [showAssigneeList, setShowAssigneeList] = useState(false);

  async function loadAssignees() {
  setLoadingAssignees(true);

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setLoadingAssignees(false);
      return;
    }

    // Get logged-in user's profile
    const { data: profile, error: profileError } =
      await supabase
        .from('profiles')
        .select(
          'id, employee_id, full_name, role, department, manager_id, director_id'
        )
        .eq('id', user.id)
        .single();

    if (profileError || !profile) {
      console.log(
        'Profile load error:',
        profileError?.message
      );
      setLoadingAssignees(false);
      return;
    }

    setCurrentProfile(profile);

    // Get all active employees
    const { data: allProfiles, error } = await supabase
      .from('profiles')
      .select(
        'id, employee_id, full_name, role, department, manager_id, director_id'
      )
      .eq('is_active', true)
      .neq('id', user.id)
      .order('full_name', { ascending: true });

    if (error) {
      console.log(
        'Assignee load error:',
        error.message
      );
      setLoadingAssignees(false);
      return;
    }

    const profiles = allProfiles || [];

    // Everyone can always create a task for themselves.
    const selfOption = {
      id: profile.id,
      employee_id: profile.employee_id,
      full_name: `${profile.full_name} (me)`,
      role: profile.role,
      department: profile.department,
      manager_id: profile.manager_id,
      director_id: profile.director_id,
    };

    // Super Admin and Director can assign company-wide
    if (
      profile.role === 'super_admin' ||
      profile.role === 'director'
    ) {
      setAssignees([selfOption, ...profiles]);
      setLoadingAssignees(false);
      return;
    }

    // Build reporting tree
    const childrenMap: Record<string, any[]> = {};

    profiles.forEach((person) => {
      if (!person.manager_id) return;

      if (!childrenMap[person.manager_id]) {
        childrenMap[person.manager_id] = [];
      }

      childrenMap[person.manager_id].push(person);
    });

    // Find everyone below the logged-in user
    const descendants: any[] = [];

    function collectDownline(managerId: string) {
      const children = childrenMap[managerId] || [];

      children.forEach((child) => {
        descendants.push(child);
        collectDownline(child.id);
      });
    }

    if (
      profile.role === 'head' ||
      profile.role === 'manager'
    ) {
      collectDownline(profile.id);

      // Managers can also create tasks for themselves.
      setAssignees([selfOption, ...descendants]);
      setLoadingAssignees(false);
      return;
    }

    // Employees: themselves only (pre-selected).
    setAssignees([selfOption]);
    setSelectedAssignee(profile.id);
    setLoadingAssignees(false);
  } catch (error) {
    console.log('Load assignees error:', error);
  }

  setLoadingAssignees(false);
}

  async function createTask() {
    if (saving) return;

    if (!title.trim()) {
      Alert.alert('Missing information', 'Please enter a task title.');
      return;
    }

    if (!selectedAssignee) {
  Alert.alert(
    'Missing information',
    'Please select an employee to assign this task to.'
  );
  return;
}
    setSaving(true);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setSaving(false);
        Alert.alert('Session expired', 'Please log in again.');
        router.replace('/');
        return;
      }

      // CREATE TASK
      const { error } = await supabase
        .from('tasks')
        .insert({
          title: title.trim(),
          description: description.trim() || null,
          created_by: user.id,
          assigned_by: user.id,
          assigned_to: selectedAssignee,
          priority,
          status: 'not_started',
          start_date: new Date().toISOString().split('T')[0],
          due_date: dueDate || null,
          parent_task_id: parentTaskId || null,
        })
        .select()
        .single();

      if (error) {
        setSaving(false);
        Alert.alert('Unable to create task', error.message);
        return;
      }

      // Task history + the assignee notification are written automatically by
      // database triggers (tasks_after_insert), so they cannot be skipped here.

      Alert.alert(
        'Task Created Successfully',
        'Your task has been created.',
        [
          {
            text: 'OK',
            onPress: () => router.replace('/dashboard'),
          },
        ]
      );
    } catch (error) {
      setSaving(false);
      Alert.alert(
        'Error',
        'Something went wrong. Please try again.'
      );
    }
  }

  useEffect(() => {
    loadAssignees();
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        {/* HEADER */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => router.back()}
          >
            <Ionicons
              name="arrow-back"
              size={22}
              color="#FFFFFF"
            />
          </TouchableOpacity>

          <View>
            <Text style={styles.headerTitle}>
              {parentTaskId ? 'Delegate Task' : 'Create Task'}
            </Text>
            <Text style={styles.headerSubtitle}>
              {parentTaskId
                ? 'Break this work into a sub-task'
                : 'Add a new company commitment'}
            </Text>
          </View>
        </View>

        {parentTaskId ? (
          <View style={styles.parentBanner}>
            <Ionicons name="git-branch-outline" size={18} color="#E87516" />
            <View style={{ flex: 1 }}>
              <Text style={styles.parentLabel}>SUB-TASK OF</Text>
              <Text style={styles.parentTitle} numberOfLines={2}>
                {parentTitle || 'Parent task'}
              </Text>
            </View>
          </View>
        ) : null}

        {/* TASK TITLE */}
        <Text style={styles.label}>TASK TITLE</Text>

        <TextInput
          value={title}
          onChangeText={setTitle}
          style={styles.input}
          placeholder="e.g. Research new CNC machine"
          placeholderTextColor="#9BA4AF"
        />

        {/* DESCRIPTION */}
        <Text style={styles.label}>DESCRIPTION</Text>

        <TextInput
          value={description}
          onChangeText={setDescription}
          style={[styles.input, styles.description]}
          placeholder="Add task details or instructions"
          placeholderTextColor="#9BA4AF"
          multiline
          textAlignVertical="top"
        />

        {/* PRIORITY */}
        <Text style={styles.label}>PRIORITY</Text>

        <View style={styles.priorityRow}>
          {['low', 'normal', 'high', 'urgent'].map((item) => (
            <TouchableOpacity
              key={item}
              style={[
                styles.priorityButton,
                priority === item && styles.prioritySelected,
              ]}
              onPress={() => setPriority(item)}
            >
              <Text
                style={[
                  styles.priorityText,
                  priority === item && styles.prioritySelectedText,
                ]}
              >
                {item.toUpperCase()}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

                {/* ASSIGN TO */}
        <Text style={styles.label}>ASSIGN TO</Text>

        <TouchableOpacity
          style={styles.inputWithIcon}
          activeOpacity={0.8}
          onPress={() =>
            setShowAssigneeList(!showAssigneeList)
          }
        >
          <Ionicons
            name="person-outline"
            size={20}
            color="#7C8795"
          />

          <Text
            style={[
              styles.dateInput,
              {
                color: selectedAssignee
                  ? '#182337'
                  : '#9BA4AF',
              },
            ]}
          >
            {selectedAssignee
              ? assignees.find(
                  (person) =>
                    person.id === selectedAssignee
                )?.full_name
              : 'Select employee'}
          </Text>

          <Ionicons
            name={
              showAssigneeList
                ? 'chevron-up'
                : 'chevron-down'
            }
            size={18}
            color="#7C8795"
          />
        </TouchableOpacity>

        {showAssigneeList && (
          <View style={styles.assigneeList}>
            {loadingAssignees ? (
              <Text style={styles.assigneeMessage}>
                Loading employees...
              </Text>
            ) : assignees.length === 0 ? (
              <Text style={styles.assigneeMessage}>
                No employees available for assignment.
              </Text>
            ) : (
              assignees.map((person) => (
                <TouchableOpacity
                  key={person.id}
                  style={styles.assigneeItem}
                  activeOpacity={0.8}
                  onPress={() => {
                    setSelectedAssignee(person.id);
                    setShowAssigneeList(false);
                  }}
                >
                  <View style={styles.assigneeAvatar}>
                    <Text style={styles.assigneeAvatarText}>
                      {person.full_name
                        ?.charAt(0)
                        ?.toUpperCase()}
                    </Text>
                  </View>

                  <View style={styles.assigneeInfo}>
                    <Text style={styles.assigneeName}>
                      {person.full_name}
                    </Text>

                    <Text style={styles.assigneeMeta}>
                      {person.employee_id}
                      {person.department
                        ? ` • ${person.department}`
                        : ''}
                    </Text>
                  </View>

                  {selectedAssignee === person.id && (
                    <Ionicons
                      name="checkmark-circle"
                      size={21}
                      color="#E87516"
                    />
                  )}
                </TouchableOpacity>
              ))
            )}
          </View>
        )}


{/* DUE DATE */}
<Text style={styles.label}>DUE DATE</Text>

{Platform.OS === 'web' ? (
  <View style={styles.inputWithIcon}>
    <Ionicons
      name="calendar-outline"
      size={20}
      color="#7C8795"
    />

    <input
      type="date"
      value={dueDate}
      min={new Date().toISOString().split('T')[0]}
      onChange={(event) => {
        setDueDate(event.target.value);
      }}
      style={{
        flex: 1,
        marginLeft: 10,
        border: 'none',
        outline: 'none',
        backgroundColor: 'transparent',
        color: '#182337',
        fontSize: 14,
        fontFamily: 'inherit',
        cursor: 'pointer',
      }}
    />
  </View>
) : (
  <>
    <TouchableOpacity
      style={styles.inputWithIcon}
      activeOpacity={0.8}
      onPress={() => setShowDueDatePicker(true)}
    >
      <Ionicons
        name="calendar-outline"
        size={20}
        color="#7C8795"
      />

      <Text
        style={[
          styles.dateInput,
          {
            color: dueDate
              ? '#182337'
              : '#9BA4AF',
          },
        ]}
      >
        {dueDate || 'Select due date'}
      </Text>

      <Ionicons
        name="chevron-down"
        size={18}
        color="#7C8795"
      />
    </TouchableOpacity>

    {showDueDatePicker && (
      <DateTimePicker
        value={
          dueDate
            ? new Date(`${dueDate}T00:00:00`)
            : new Date()
        }
        mode="date"
        display="default"
        minimumDate={new Date()}
        onChange={(event, selectedDate) => {
          if (event.type === 'dismissed') {
            setShowDueDatePicker(false);
            return;
          }

          if (selectedDate) {
            const year =
              selectedDate.getFullYear();

            const month = String(
              selectedDate.getMonth() + 1
            ).padStart(2, '0');

            const day = String(
              selectedDate.getDate()
            ).padStart(2, '0');

            setDueDate(
              `${year}-${month}-${day}`
            );
          }

          setShowDueDatePicker(false);
        }}
      />
    )}
  </>
)}

        {/* ASSIGNMENT NOTE */}
        <View style={styles.infoBox}>
          <Ionicons
            name="information-circle-outline"
            size={21}
            color="#F28C28"
          />

          <Text style={styles.infoText}>
            Select the employee responsible for this task.
            The selected employee will become the task owner.
          </Text>
        </View>

        {/* CREATE BUTTON */}
        <TouchableOpacity
          style={[
            styles.createButton,
            saving && styles.disabledButton,
          ]}
          onPress={createTask}
          disabled={saving}
        >
          <Text style={styles.createButtonText}>
            {saving ? 'CREATING...' : 'CREATE TASK'}
          </Text>

          {!saving && (
            <Ionicons
              name="arrow-forward"
              size={20}
              color="#FFFFFF"
            />
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F5F7',
  },

  content: {
    paddingBottom: 40,
  },

  header: {
    backgroundColor: '#12233F',
    paddingHorizontal: 20,
    paddingTop: 55,
    paddingBottom: 22,
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

  headerTitle: {
    color: '#FFFFFF',
    fontSize: 25,
    fontWeight: '900',
  },

  headerSubtitle: {
    color: '#B9C1CC',
    fontSize: 11,
    marginTop: 3,
  },

  label: {
    color: '#344258',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.1,
    marginHorizontal: 20,
    marginTop: 22,
    marginBottom: 8,
  },

  input: {
    marginHorizontal: 20,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DCE1E6',
    borderRadius: 10,
    height: 52,
    paddingHorizontal: 14,
    color: '#182337',
    fontSize: 14,
  },

  description: {
    height: 110,
    paddingTop: 14,
  },

  priorityRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    gap: 7,
  },

  priorityButton: {
    flex: 1,
    height: 42,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#DCE1E6',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },

  prioritySelected: {
    backgroundColor: '#12233F',
    borderColor: '#12233F',
  },

  priorityText: {
    color: '#687382',
    fontSize: 9,
    fontWeight: '900',
  },

  prioritySelectedText: {
    color: '#FFFFFF',
  },

  inputWithIcon: {
    marginHorizontal: 20,
    height: 52,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DCE1E6',
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
  },

    assigneeList: {
    marginHorizontal: 20,
    marginTop: 6,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DCE1E6',
    borderRadius: 10,
    overflow: 'hidden',
  },

  assigneeItem: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#EDF0F2',
  },

  assigneeAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#12233F',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 11,
  },

  assigneeAvatarText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
  },

  assigneeInfo: {
    flex: 1,
  },

  assigneeName: {
    color: '#182337',
    fontSize: 13,
    fontWeight: '800',
  },

  assigneeMeta: {
    color: '#7C8795',
    fontSize: 10,
    marginTop: 3,
  },

  assigneeMessage: {
    color: '#7C8795',
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 18,
    paddingHorizontal: 12,
  },

  dateInput: {
    flex: 1,
    marginLeft: 10,
    color: '#182337',
    fontSize: 14,
  },

  infoBox: {
    marginHorizontal: 20,
    marginTop: 22,
    padding: 14,
    backgroundColor: '#FFF5EA',
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },

  infoText: {
    flex: 1,
    color: '#6E6256',
    fontSize: 11,
    lineHeight: 17,
    marginLeft: 10,
  },

  createButton: {
    marginHorizontal: 20,
    marginTop: 25,
    height: 55,
    backgroundColor: '#12233F',
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },

  disabledButton: {
    opacity: 0.6,
  },

  createButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1.2,
  },

  parentBanner: {
    marginHorizontal: 20,
    marginTop: 18,
    padding: 13,
    backgroundColor: '#FFF5EA',
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: '#F3D1B3',
  },

  parentLabel: {
    color: '#9A6B3F',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
  },

  parentTitle: {
    color: '#12233F',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 3,
  },
});