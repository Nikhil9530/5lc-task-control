import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { supabase } from '../../lib/supabase';

type Task = {
  id: string;
  title: string;
  description: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status:
    | 'not_started'
    | 'in_progress'
    | 'waiting'
    | 'completed'
    | 'rejected';
  due_date: string | null;
  parent_task_id: string | null;
};

export default function TasksScreen() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadTasks();
  }, []);

  async function loadTasks() {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setTasks([]);
        return;
      }

      const { data, error } = await supabase
        .from('tasks')
        .select(
          'id, title, description, priority, status, due_date, parent_task_id'
        )
        .eq('assigned_to', user.id)
        .order('due_date', {
          ascending: true,
          nullsFirst: false,
        });

      if (error) {
        console.log('Load tasks error:', error.message);
        return;
      }

      setTasks(data ?? []);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function refreshTasks() {
    setRefreshing(true);
    await loadTasks();
  }

  function isOverdue(task: Task) {
    if (!task.due_date || task.status === 'completed') {
      return false;
    }

    const today = new Date().toISOString().split('T')[0];

    return task.due_date < today;
  }

  function formatStatus(status: Task['status']) {
    return status.replace('_', ' ').toUpperCase();
  }

  function formatPriority(priority: Task['priority']) {
    return priority.toUpperCase();
  }

  function renderTask({ item }: { item: Task }) {
    const overdue = isOverdue(item);

    return (
      <TouchableOpacity
        style={styles.taskCard}
        activeOpacity={0.8}
        onPress={() =>
          router.push({
            pathname: '/task-detail',
            params: { id: item.id },
          })
        }
      >
        <View style={styles.taskTop}>
          <Text style={styles.taskTitle}>
            {item.title}
          </Text>

          <View style={styles.priorityBadge}>
            <Text style={styles.priorityText}>
              {formatPriority(item.priority)}
            </Text>
          </View>
        </View>

        {item.description ? (
          <Text
            style={styles.description}
            numberOfLines={2}
          >
            {item.description}
          </Text>
        ) : null}

        <View style={styles.taskBottom}>
          <View>
            <Text style={styles.label}>STATUS</Text>

            <Text style={styles.status}>
              {formatStatus(item.status)}
            </Text>
          </View>

          <View style={styles.dueContainer}>
            <Text style={styles.label}>DUE DATE</Text>

            <Text
              style={[
                styles.dueDate,
                overdue && styles.overdue,
              ]}
            >
              {item.due_date || 'No deadline'}
            </Text>
          </View>
        </View>

        {overdue && (
          <View style={styles.overdueBox}>
            <Text style={styles.overdueText}>
              OVERDUE
            </Text>
          </View>
        )}

        <View style={styles.viewTaskRow}>
          <Text style={styles.viewTaskText}>
            VIEW TASK
          </Text>

          <Text style={styles.arrow}>
            ›
          </Text>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
  <View style={styles.headerRow}>
    <TouchableOpacity
      style={styles.backButton}
      activeOpacity={0.8}
      onPress={() => router.back()}
    >
      <Ionicons
        name="arrow-back"
        size={22}
        color="#FFFFFF"
      />
    </TouchableOpacity>

    <View style={styles.headerText}>
      <Text style={styles.title}>Tasks</Text>

      <Text style={styles.subtitle}>
        Company Task Management
      </Text>
    </View>
  </View>
</View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" />

          <Text style={styles.loadingText}>
            Loading tasks...
          </Text>
        </View>
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={(item) => item.id}
          renderItem={renderTask}
          contentContainerStyle={
            tasks.length === 0
              ? styles.emptyContainer
              : styles.listContainer
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refreshTasks}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyTitle}>
                No Tasks
              </Text>

              <Text style={styles.emptyText}>
                You don't have any assigned tasks yet.
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F5F7',
  },

  header: {
  backgroundColor: '#12233F',
  paddingHorizontal: 20,
  paddingTop: 55,
  paddingBottom: 22,
},

headerRow: {
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
headerText: {
  flex: 1,
},

title: {
  color: '#FFFFFF',
  fontSize: 26,
  fontWeight: '900',
},

subtitle: {
  color: '#B9C1CC',
  fontSize: 14,
  marginTop: 4,
},

  listContainer: {
    padding: 16,
  },

  taskCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2E6EA',
  },

  taskTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },

  taskTitle: {
    flex: 1,
    color: '#12233F',
    fontSize: 17,
    fontWeight: '800',
    marginRight: 10,
  },

  priorityBadge: {
    backgroundColor: '#FFF1E6',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 6,
  },

  priorityText: {
    color: '#E87516',
    fontSize: 10,
    fontWeight: '900',
  },

  description: {
    color: '#6F7884',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 9,
  },

  taskBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
  },

  label: {
    color: '#9AA2AC',
    fontSize: 9,
    fontWeight: '800',
    marginBottom: 4,
  },

  status: {
    color: '#12233F',
    fontSize: 12,
    fontWeight: '700',
  },

  dueContainer: {
    alignItems: 'flex-end',
  },

  dueDate: {
    color: '#12233F',
    fontSize: 12,
    fontWeight: '700',
  },

  overdue: {
    color: '#D64545',
  },

  overdueBox: {
    backgroundColor: '#FDECEC',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 9,
    alignSelf: 'flex-start',
    marginTop: 12,
  },

  overdueText: {
    color: '#D64545',
    fontSize: 10,
    fontWeight: '900',
  },

  viewTaskRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: 14,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#EEF0F2',
  },

  viewTaskText: {
    color: '#E87516',
    fontSize: 10,
    fontWeight: '900',
  },

  arrow: {
    color: '#E87516',
    fontSize: 22,
    marginLeft: 5,
    lineHeight: 18,
  },

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  loadingText: {
    color: '#7A8491',
    marginTop: 10,
    fontSize: 13,
  },

  emptyContainer: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
  },

  emptyBox: {
    alignItems: 'center',
  },

  emptyTitle: {
    color: '#12233F',
    fontSize: 20,
    fontWeight: '800',
  },

  emptyText: {
    color: '#7A8491',
    fontSize: 13,
    marginTop: 6,
    textAlign: 'center',
  },
});