import React, {
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';

type NotificationItem = {
  notification_id: string;

  recipient_uuid: string;
  recipient_name: string | null;
  recipient_employee_id: string | null;
  recipient_role: string | null;
  recipient_department: string | null;

  type: string;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;

  task_id: string | null;
  task_title: string | null;
  task_status: string | null;
  task_priority: string | null;
  task_due_date: string | null;

  extension_id: string | null;
  old_due_date: string | null;
  requested_due_date: string | null;
  extension_reason: string | null;
  extension_status: string | null;

  requester_uuid: string | null;
  requester_name: string | null;
  requester_employee_id: string | null;
  requester_role: string | null;
  requester_department: string | null;

  reviewer_uuid: string | null;
  reviewer_name: string | null;
  reviewer_employee_id: string | null;
  reviewer_role: string | null;
  reviewer_department: string | null;

  reviewed_at: string | null;
  review_comment: string | null;
};

function formatRole(role: string | null) {
  if (!role) return '';

  return role
    .replace('_', ' ')
    .replace(/\b\w/g, (char) =>
      char.toUpperCase()
    );
}

function formatDateTime(
  value: string
) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function NotificationsScreen() {
  const [notifications, setNotifications] =
    useState<NotificationItem[]>([]);

  const [loading, setLoading] =
    useState(true);

  const [refreshing, setRefreshing] =
    useState(false);

  const [processingId, setProcessingId] =
    useState<string | null>(null);

  const loadNotifications =
    useCallback(async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          Alert.alert(
            'Session Expired',
            'Please log in again.'
          );

          router.replace('/');
          return;
        }

        const { data, error } =
          await supabase
            .from(
              'notifications_with_names'
            )
            .select('*')
            .order('created_at', {
              ascending: false,
            });

        if (error) {
          console.error(
            'Notifications error:',
            error
          );

          Alert.alert(
            'Unable to load notifications',
            error.message
          );

          return;
        }

        setNotifications(
          (data ?? []) as NotificationItem[]
        );
      } catch (error: any) {
        console.error(
          'Load notifications error:',
          error
        );

        Alert.alert(
          'Error',
          error?.message ||
            'Unable to load notifications.'
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    }, []);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadNotifications();
  };

  const markAsRead = async (
    notificationId: string
  ) => {
    if (processingId) return;

    try {
      setProcessingId(notificationId);

      const { error } =
        await supabase
          .from('notifications')
          .update({
            is_read: true,
          })
          .eq('id', notificationId)
          .eq(
            'user_id',
            (await supabase.auth.getUser())
              .data.user?.id
          );

      if (error) {
        console.error(
          'Mark notification read error:',
          error
        );

        Alert.alert(
          'Unable to update notification',
          error.message
        );

        return;
      }

      setNotifications((current) =>
        current.map((item) =>
          item.notification_id ===
          notificationId
            ? {
                ...item,
                is_read: true,
              }
            : item
        )
      );
    } finally {
      setProcessingId(null);
    }
  };

  const openNotification = async (
    item: NotificationItem
  ) => {
    if (!item.is_read) {
      await markAsRead(
        item.notification_id
      );
    }

    if (item.task_id) {
      router.push({
        pathname: '/task-detail',
        params: {
          id: item.task_id,
        },
      });
    }
  };

  const unreadCount =
    notifications.filter(
      (item) => !item.is_read
    ).length;

  return (
    <SafeAreaView style={styles.container}>
      {/* HEADER */}
      <View style={styles.header}>
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
          <Text style={styles.headerTitle}>
            Notifications
          </Text>

          <Text style={styles.headerSubtitle}>
            Your task and company updates
          </Text>
        </View>

        <View style={styles.headerIcon}>
          <Ionicons
            name="notifications-outline"
            size={22}
            color="#E87516"
          />

          {unreadCount > 0 && (
            <View style={styles.headerBadge}>
              <Text style={styles.headerBadgeText}>
                {unreadCount > 99
                  ? '99+'
                  : unreadCount}
              </Text>
            </View>
          )}
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#E87516"
          />
        }
      >
        {loading ? (
          <View style={styles.centerState}>
            <ActivityIndicator
              size="large"
              color="#E87516"
            />

            <Text
              style={styles.loadingText}
            >
              Loading notifications...
            </Text>
          </View>
        ) : notifications.length === 0 ? (
          <View style={styles.emptyCard}>
            <View
              style={styles.emptyIcon}
            >
              <Ionicons
                name="notifications-off-outline"
                size={30}
                color="#7A8491"
              />
            </View>

            <Text style={styles.emptyTitle}>
              No Notifications
            </Text>

            <Text style={styles.emptyText}>
              You are all caught up. New task
              and extension updates will appear
              here.
            </Text>
          </View>
        ) : (
          <>
            {unreadCount > 0 && (
              <View style={styles.summaryCard}>
                <View>
                  <Text
                    style={
                      styles.summaryLabel
                    }
                  >
                    UNREAD
                  </Text>

                  <Text
                    style={
                      styles.summaryValue
                    }
                  >
                    {unreadCount}
                  </Text>
                </View>

                <Ionicons
                  name="mail-unread-outline"
                  size={25}
                  color="#E87516"
                />
              </View>
            )}

            {notifications.map((item) => {
              const isProcessing =
                processingId ===
                item.notification_id;

              const approved =
                item.type ===
                'extension_approved';

              return (
                <TouchableOpacity
                  key={
                    item.notification_id
                  }
                  activeOpacity={0.85}
                  style={[
                    styles.notificationCard,
                    !item.is_read &&
                      styles.unreadCard,
                  ]}
                  onPress={() =>
                    openNotification(item)
                  }
                  disabled={isProcessing}
                >
                  <View style={styles.topRow}>
                    <View
                      style={[
                        styles.iconCircle,
                        approved
                          ? styles.approvedIcon
                          : styles.rejectedIcon,
                      ]}
                    >
                      <Ionicons
                        name={
                          approved
                            ? 'checkmark-circle-outline'
                            : 'close-circle-outline'
                        }
                        size={22}
                        color={
                          approved
                            ? '#2E8B57'
                            : '#B42318'
                        }
                      />
                    </View>

                    <View
                      style={
                        styles.notificationHeader
                      }
                    >
                      <Text
                        style={
                          styles.notificationTitle
                        }
                      >
                        {item.title}
                      </Text>

                      <Text
                        style={
                          styles.notificationDate
                        }
                      >
                        {formatDateTime(
                          item.created_at
                        )}
                      </Text>
                    </View>

                    {!item.is_read && (
                      <View
                        style={
                          styles.unreadDot
                        }
                      />
                    )}
                  </View>

                  <Text
                    style={
                      styles.notificationMessage
                    }
                  >
                    {item.message}
                  </Text>

                  {item.task_title && (
                    <View
                      style={
                        styles.taskBox
                      }
                    >
                      <Ionicons
                        name="clipboard-outline"
                        size={16}
                        color="#E87516"
                      />

                      <Text
                        style={
                          styles.taskText
                        }
                        numberOfLines={2}
                      >
                        {item.task_title}
                      </Text>
                    </View>
                  )}

                  {item.reviewer_name && (
                    <View
                      style={
                        styles.reviewerBox
                      }
                    >
                      <Text
                        style={
                          styles.reviewerLabel
                        }
                      >
                        REVIEWED BY
                      </Text>

                      <Text
                        style={
                          styles.reviewerName
                        }
                      >
                        {item.reviewer_name}
                      </Text>

                      <Text
                        style={
                          styles.reviewerMeta
                        }
                      >
                        {item.reviewer_employee_id
                          ? `${item.reviewer_employee_id}  •  `
                          : ''}
                        {formatRole(
                          item.reviewer_role
                        )}
                        {item.reviewer_department
                          ? `  •  ${item.reviewer_department}`
                          : ''}
                      </Text>
                    </View>
                  )}

                  {!item.is_read && (
                    <View
                      style={
                        styles.markReadRow
                      }
                    >
                      <TouchableOpacity
                        activeOpacity={0.8}
                        onPress={(event) => {
                          event.stopPropagation();
                          markAsRead(
                            item.notification_id
                          );
                        }}
                      >
                        <Text
                          style={
                            styles.markReadText
                          }
                        >
                          MARK AS READ
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </>
        )}
      </ScrollView>
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
    paddingHorizontal: 20,
    paddingTop: 55,
    paddingBottom: 22,
    flexDirection: 'row',
    alignItems: 'center',
  },

  backButton: {
    width: 42,
    height: 42,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 11,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },

  headerText: {
    flex: 1,
  },

  headerTitle: {
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '900',
  },

  headerSubtitle: {
    color: '#B9C2CF',
    fontSize: 11,
    marginTop: 3,
  },

  headerIcon: {
    width: 43,
    height: 43,
    borderRadius: 12,
    backgroundColor: '#FFF0E5',
    justifyContent: 'center',
    alignItems: 'center',
  },

  headerBadge: {
    position: 'absolute',
    right: -4,
    top: -5,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: '#D64545',
    justifyContent: 'center',
    alignItems: 'center',
  },

  headerBadgeText: {
    color: '#FFFFFF',
    fontSize: 8,
    fontWeight: '900',
  },

  content: {
    padding: 16,
    paddingBottom: 35,
  },

  summaryCard: {
    marginBottom: 14,
    padding: 16,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E3E7EB',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  summaryLabel: {
    color: '#7A8491',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
  },

  summaryValue: {
    marginTop: 3,
    color: '#12233F',
    fontSize: 22,
    fontWeight: '900',
  },

  notificationCard: {
    marginBottom: 12,
    padding: 15,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E6EA',
  },

  unreadCard: {
    borderColor: '#F1C8A7',
    backgroundColor: '#FFFDFB',
  },

  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  iconCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },

  approvedIcon: {
    backgroundColor: '#EAF7EF',
  },

  rejectedIcon: {
    backgroundColor: '#FDEBEC',
  },

  notificationHeader: {
    flex: 1,
  },

  notificationTitle: {
    color: '#12233F',
    fontSize: 14,
    fontWeight: '900',
  },

  notificationDate: {
    color: '#9AA2AC',
    fontSize: 9,
    marginTop: 3,
  },

  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#E87516',
    marginLeft: 8,
  },

  notificationMessage: {
    marginTop: 12,
    color: '#4E5865',
    fontSize: 12,
    lineHeight: 18,
  },

  taskBox: {
    marginTop: 12,
    padding: 10,
    borderRadius: 9,
    backgroundColor: '#FFF7F0',
    borderWidth: 1,
    borderColor: '#F3D1B3',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  taskText: {
    flex: 1,
    color: '#12233F',
    fontSize: 11,
    fontWeight: '800',
    lineHeight: 16,
  },

  reviewerBox: {
    marginTop: 11,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#EDF0F2',
  },

  reviewerLabel: {
    color: '#9AA2AC',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  reviewerName: {
    marginTop: 4,
    color: '#12233F',
    fontSize: 12,
    fontWeight: '900',
  },

  reviewerMeta: {
    marginTop: 2,
    color: '#7A8491',
    fontSize: 9,
    fontWeight: '600',
  },

  markReadRow: {
    marginTop: 12,
    alignItems: 'flex-end',
  },

  markReadText: {
    color: '#E87516',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  emptyCard: {
    marginTop: 45,
    padding: 28,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E3E7EB',
    alignItems: 'center',
  },

  emptyIcon: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#F0F2F4',
    justifyContent: 'center',
    alignItems: 'center',
  },

  emptyTitle: {
    marginTop: 15,
    color: '#12233F',
    fontSize: 16,
    fontWeight: '900',
  },

  emptyText: {
    marginTop: 7,
    color: '#7A8491',
    fontSize: 11,
    lineHeight: 17,
    textAlign: 'center',
    maxWidth: 290,
  },

  centerState: {
    minHeight: 320,
    justifyContent: 'center',
    alignItems: 'center',
  },

  loadingText: {
    marginTop: 10,
    color: '#7A8491',
    fontSize: 12,
  },
});