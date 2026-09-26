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
import { goBack, nav } from '../../lib/navigation';
import {
  acknowledgeNotifications,
  clearReadNotifications,
  dismissTrayEntriesForIds,
  syncTrayWithInbox,
} from '../../lib/notificationCenter';
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

  // READ notifications were previously listed forever next to the unread ones,
  // which is how a three-day-old notification was still "there". The inbox now
  // opens on UNREAD (actionable) and ALL is an explicit opt-in.
  const [filter, setFilter] =
    useState<'unread' | 'all'>('unread');

  // True unread total from the database, independent of the loaded page, so the
  // badge is correct even when the ALL filter is showing 100 read rows.
  const [unreadTotal, setUnreadTotal] =
    useState(0);

  const [bulkBusy, setBulkBusy] =
    useState(false);

  const loadNotifications =
    useCallback(async () => {
      try {
        // getSession() reads local secure storage. getUser() made a NETWORK
        // round-trip to the auth server on every load, which was the main
        // reason this screen felt slow to open.
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session) {
          Alert.alert(
            'Session Expired',
            'Please log in again.'
          );

          router.replace('/');
          return;
        }

        // Base builder is reused by both branches; .eq() does not mutate it, so
        // each branch gets its own independent chain.
        const baseQuery = supabase
          .from('notifications_with_names')
          .select('*');

        const listPromise = (
          filter === 'unread'
            ? baseQuery.eq('is_read', false)
            : baseQuery
        )
          .order('created_at', {
            ascending: false,
          })
          // Bounded page: an unbounded inbox was another way this screen got
          // slow, and there is no reason to render months of history at once.
          .limit(100);

        // The list and the true unread count are independent, so fetch them
        // together instead of one after the other.
        const [listResult, unreadResult] =
          await Promise.all([
            listPromise,
            supabase
              .from('notifications')
              .select('id', {
                count: 'exact',
                head: true,
              })
              .eq('is_read', false),
          ]);

        const { data, error } = listResult;

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

        setUnreadTotal(unreadResult.count ?? 0);

        // Anything the user has already read must not still be sitting in the
        // Android tray. Reconciling here means simply opening this screen
        // clears out stale tray entries and resets the badge.
        await syncTrayWithInbox();
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
    }, [filter]);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadNotifications();
  };

  // Acknowledge a notification: flip is_read in ONE round-trip
  // (mark_notifications_read is security-invoker, so it can only ever touch the
  // caller's own rows), then remove its Android tray entry and reset the badge.
  // The tray dismissal is the part that was missing before - which is exactly
  // why a handled notification stayed visible for days.
  const markAsRead = async (
    notificationId: string
  ) => {
    if (processingId) return;

    try {
      setProcessingId(notificationId);

      await acknowledgeNotifications([
        notificationId,
      ]);

      setNotifications((current) => {
        const updated = current.map((item) =>
          item.notification_id ===
          notificationId
            ? {
                ...item,
                is_read: true,
              }
            : item
        );

        // On the UNREAD tab an acknowledged item no longer belongs here.
        return filter === 'unread'
          ? updated.filter(
              (item) => !item.is_read
            )
          : updated;
      });

      setUnreadTotal((current) =>
        Math.max(0, current - 1)
      );
    } catch (error: any) {
      console.error(
        'Mark notification read error:',
        error
      );

      Alert.alert(
        'Unable to update notification',
        error?.message || 'Please try again.'
      );
    } finally {
      setProcessingId(null);
    }
  };

  const openNotification = async (
    item: NotificationItem
  ) => {
    if (!item.is_read) {
      await markAsRead(item.notification_id);
    } else {
      // Already read, so no row update is needed - but its tray entry must not
      // be left behind either.
      await dismissTrayEntriesForIds([
        item.notification_id,
      ]);
    }

    if (item.extension_id) {
      nav('/extensions');
      return;
    }

    if (item.task_id) {
      nav({
        pathname: '/task-detail',
        params: {
          id: item.task_id,
        },
      });
    }
  };

  const changeFilter = (
    next: 'unread' | 'all'
  ) => {
    if (next === filter) return;

    setLoading(true);
    setFilter(next);
  };

  const markAllRead = async () => {
    if (bulkBusy) return;

    try {
      setBulkBusy(true);

      // null = acknowledge everything, then clear the tray and the badge.
      await acknowledgeNotifications(null);

      setNotifications([]);
      setUnreadTotal(0);
    } catch (error: any) {
      Alert.alert(
        'Unable to mark all as read',
        error?.message || 'Please try again.'
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const clearRead = async () => {
    if (bulkBusy) return;

    try {
      setBulkBusy(true);

      await clearReadNotifications();
      await loadNotifications();
    } catch (error: any) {
      Alert.alert(
        'Unable to clear notifications',
        error?.message || 'Please try again.'
      );
    } finally {
      setBulkBusy(false);
    }
  };

  // The header badge shows the TRUE unread total, not merely what the current
  // page happens to hold.
  const unreadCount = unreadTotal;

  return (
    <SafeAreaView style={styles.container}>
      {/* HEADER */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          activeOpacity={0.8}
          onPress={() => goBack()}
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
        {/* FILTER + BULK ACTIONS */}
        <View style={styles.toolbar}>
          <View style={styles.chipRow}>
            <TouchableOpacity
              activeOpacity={0.85}
              style={[
                styles.chip,
                filter === 'unread' &&
                  styles.chipActive,
              ]}
              onPress={() =>
                changeFilter('unread')
              }
            >
              <Text
                style={[
                  styles.chipText,
                  filter === 'unread' &&
                    styles.chipTextActive,
                ]}
              >
                UNREAD
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.85}
              style={[
                styles.chip,
                filter === 'all' &&
                  styles.chipActive,
              ]}
              onPress={() => changeFilter('all')}
            >
              <Text
                style={[
                  styles.chipText,
                  filter === 'all' &&
                    styles.chipTextActive,
                ]}
              >
                ALL
              </Text>
            </TouchableOpacity>
          </View>

          {!loading &&
            (unreadTotal > 0 ||
              filter === 'all') && (
              <View style={styles.actionRow}>
                {unreadTotal > 0 && (
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={markAllRead}
                    disabled={bulkBusy}
                  >
                    <Text
                      style={styles.actionText}
                    >
                      MARK ALL READ
                    </Text>
                  </TouchableOpacity>
                )}

                {filter === 'all' && (
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={clearRead}
                    disabled={bulkBusy}
                  >
                    <Text
                      style={styles.actionText}
                    >
                      CLEAR READ
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
        </View>


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
              {filter === 'unread'
                ? 'All Caught Up'
                : 'No Notifications'}
            </Text>

            <Text style={styles.emptyText}>
              {filter === 'unread'
                ? 'Nothing needs your attention. Read notifications move out of this list.'
                : 'Nothing here yet. Task and extension updates will appear here.'}
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

  toolbar: {
    marginBottom: 12,
  },

  chipRow: {
    flexDirection: 'row',
    gap: 8,
  },

  chip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E6EA',
  },

  chipActive: {
    backgroundColor: '#12233F',
    borderColor: '#12233F',
  },

  chipText: {
    color: '#7A8491',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  chipTextActive: {
    color: '#FFFFFF',
  },

  actionRow: {
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 18,
  },

  actionText: {
    color: '#E87516',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
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