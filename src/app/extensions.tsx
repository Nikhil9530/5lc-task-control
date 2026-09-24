import React, { useCallback, useEffect, useState } from 'react';
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

type Profile = {
  id: string;
  employee_id: string;
  full_name: string;
  role: 'super_admin' | 'director' | 'head' | 'manager' | 'employee';
  department: string | null;
  manager_id: string | null;
  director_id: string | null;
  is_active: boolean;
};

type ExtensionRequest = {
  id: string;
  task_id: string;
  requested_by: string;
  old_due_date: string | null;
  requested_due_date: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  created_at: string;
  taskTitle: string;
  employeeName: string;
  employeeId: string;
  department: string | null;
};

const formatDate = (dateString: string | null | undefined) => {
  if (!dateString) return 'Not set';

  const date = new Date(`${dateString}T00:00:00`);

  if (Number.isNaN(date.getTime())) return dateString;

  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

const formatDateTime = (dateString: string | null | undefined) => {
  if (!dateString) return '';

  const date = new Date(dateString);

  if (Number.isNaN(date.getTime())) return dateString;

  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export default function ExtensionsScreen() {
  const [requests, setRequests] = useState<ExtensionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setRequests([]);
        setLoading(false);

        Alert.alert(
          'Session Expired',
          'Please log in again.'
        );

        router.replace('/');
        return;
      }

      // Load current user's profile
      const { data: currentProfile, error: profileError } =
        await supabase
          .from('profiles')
          .select(
            'id, employee_id, full_name, role, department, manager_id, director_id, is_active'
          )
          .eq('id', user.id)
          .single();

      if (profileError) {
        console.error(
          'Current profile error:',
          profileError
        );

        Alert.alert(
          'Error',
          'Unable to load your profile.'
        );

        setRequests([]);
        return;
      }

      // Load pending extension requests
      const {
        data: extensionData,
        error: extensionError,
      } = await supabase
        .from('task_extensions')
        .select(
          'id, task_id, requested_by, old_due_date, requested_due_date, reason, status, reviewed_by, reviewed_at, review_comment, created_at'
        )
        .eq('status', 'pending')
        .order('created_at', {
          ascending: false,
        });

      if (extensionError) {
        console.error(
          'Extension requests error:',
          extensionError
        );

        Alert.alert(
          'Error',
          extensionError.message
        );

        setRequests([]);
        return;
      }

      if (
        !extensionData ||
        extensionData.length === 0
      ) {
        setRequests([]);
        return;
      }

      const taskIds = Array.from(
        new Set(
          extensionData.map(
            (item) => item.task_id
          )
        )
      );

      const requesterIds = Array.from(
        new Set(
          extensionData.map(
            (item) => item.requested_by
          )
        )
      );

      const [
        tasksResult,
        profilesResult,
      ] = await Promise.all([
        supabase
          .from('tasks')
          .select(
            'id, title, assigned_to, assigned_by'
          )
          .in('id', taskIds),

        supabase
          .from('profiles')
          .select(
            'id, employee_id, full_name, role, department, manager_id, director_id, is_active'
          )
          .in('id', requesterIds),
      ]);

      if (tasksResult.error) {
        console.error(
          'Tasks lookup error:',
          tasksResult.error
        );

        Alert.alert(
          'Error',
          tasksResult.error.message
        );

        setRequests([]);
        return;
      }

      if (profilesResult.error) {
        console.error(
          'Profiles lookup error:',
          profilesResult.error
        );

        Alert.alert(
          'Error',
          profilesResult.error.message
        );

        setRequests([]);
        return;
      }

      const tasksById = new Map(
        (tasksResult.data ?? []).map(
          (task) => [task.id, task]
        )
      );

      const profilesById = new Map(
        (profilesResult.data ?? []).map(
          (profile) => [profile.id, profile]
        )
      );

      /*
       * Build a profile map containing enough information
       * to determine the reviewer's hierarchy.
       */
      const allProfiles =
        new Map<string, Profile>();

      let hierarchyProfiles: Profile[] =
        profilesResult.data ?? [];

      if (
        currentProfile.role !== 'employee'
      ) {
        const {
          data: allActiveProfiles,
          error: hierarchyError,
        } = await supabase
          .from('profiles')
          .select(
            'id, employee_id, full_name, role, department, manager_id, director_id, is_active'
          )
          .eq('is_active', true);

        if (hierarchyError) {
          console.error(
            'Hierarchy profile error:',
            hierarchyError
          );
        } else {
          hierarchyProfiles =
            allActiveProfiles ??
            hierarchyProfiles;
        }
      }

      hierarchyProfiles.forEach(
        (profile) => {
          allProfiles.set(
            profile.id,
            profile as Profile
          );
        }
      );

      allProfiles.set(
        currentProfile.id,
        currentProfile as Profile
      );

      /*
       * Determine whether the signed-in user has authority over a specific
       * employee's extension request.
       *
       * RULE: upline only. Walk the manager chain upward from the employee -
       * if it reaches the current user, they may review. A Director does NOT
       * get blanket access (only if they are in that person's chain, or if the
       * employee has no manager and the Director is their director).
       *
       * The database enforces the same rule (migration 0013) - this is UX only.
       */
      const canReviewEmployee = (
        employee: Profile
      ) => {
        if (!employee?.is_active) {
          return false;
        }

        // System operator keeps global access for support.
        if (currentProfile.role === 'super_admin') {
          return true;
        }

        // Employee with no manager -> their director approves.
        if (
          !employee.manager_id &&
          employee.director_id === currentProfile.id
        ) {
          return true;
        }

        // Walk up the reporting line.
        const visited = new Set<string>();

        let managerId = employee.manager_id;

        while (managerId) {
          if (managerId === currentProfile.id) {
            return true;
          }

          if (visited.has(managerId)) {
            break;
          }

          visited.add(managerId);

          const manager = allProfiles.get(managerId);

          managerId = manager?.manager_id ?? null;
        }

        return false;
      };

      const enriched: ExtensionRequest[] =
        [];

      for (
        const extension of extensionData
      ) {
        const task = tasksById.get(
          extension.task_id
        );

        const employee = task
          ? (allProfiles.get(
              task.assigned_to
            ) as
              | Profile
              | undefined)
          : undefined;

        const requester =
          profilesById.get(
            extension.requested_by
          );

        // Normally task assignee is the employee.
        // Fallback to requester if needed.
        const displayEmployee =
          employee ?? requester;

        if (!displayEmployee) {
          continue;
        }

        if (
          !canReviewEmployee(
            displayEmployee as Profile
          )
        ) {
          continue;
        }

        enriched.push({
          ...extension,
          taskTitle:
            task?.title ??
            'Task not found',
          employeeName:
            displayEmployee.full_name,
          employeeId:
            displayEmployee.employee_id,
          department:
            displayEmployee.department,
        });
      }

      setRequests(enriched);
    } catch (error: any) {
      console.error(
        'Load extension requests error:',
        error
      );

      Alert.alert(
        'Error',
        error?.message ||
          'Unable to load extension requests.'
      );

      setRequests([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadRequests();
  };

  const approveExtension = async (
    extensionId: string
  ) => {
    if (processingId) {
      return;
    }

    try {
      setProcessingId(extensionId);

      const { error } =
        await supabase.rpc(
          'review_task_extension',
          {
            p_extension_id:
              extensionId,
            p_action:
              'approved',
            p_review_comment:
              null,
          }
        );

      if (error) {
        console.error(
          'Approve extension error:',
          error
        );

        Alert.alert(
          'Approval Failed',
          error.message
        );

        return;
      }

      Alert.alert(
        'Extension Approved',
        'The task deadline has been updated successfully.'
      );

      await loadRequests();
    } catch (error: any) {
      console.error(
        'Approve extension error:',
        error
      );

      Alert.alert(
        'Error',
        error?.message ||
          'Something went wrong while approving the request.'
      );
    } finally {
      setProcessingId(null);
    }
  };

  const rejectExtension = async (
    extensionId: string
  ) => {
    if (processingId) {
      return;
    }

    Alert.alert(
      'Reject Extension',
      'Are you sure you want to reject this extension request?',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: async () => {
            try {
              setProcessingId(
                extensionId
              );

              const { error } =
                await supabase.rpc(
                  'review_task_extension',
                  {
                    p_extension_id:
                      extensionId,
                    p_action:
                      'rejected',
                    p_review_comment:
                      null,
                  }
                );

              if (error) {
                console.error(
                  'Reject extension error:',
                  error
                );

                Alert.alert(
                  'Rejection Failed',
                  error.message
                );

                return;
              }

              Alert.alert(
                'Extension Rejected',
                'The original task deadline remains unchanged.'
              );

              await loadRequests();
            } catch (error: any) {
              console.error(
                'Reject extension error:',
                error
              );

              Alert.alert(
                'Error',
                error?.message ||
                  'Something went wrong while rejecting the request.'
              );
            } finally {
              setProcessingId(null);
            }
          },
        },
      ]
    );
  };

  const renderRequestCard = (
    item: ExtensionRequest
  ) => {
    const isProcessing =
      processingId === item.id;

    return (
      <View
        key={item.id}
        style={styles.requestCard}
      >
        {/* EMPLOYEE HEADER */}
        <View style={styles.cardTopRow}>
          <View
            style={styles.employeeBlock}
          >
            <View style={styles.avatar}>
              <Text
                style={styles.avatarText}
              >
                {item.employeeName
                  ?.charAt(0)
                  ?.toUpperCase() ||
                  'E'}
              </Text>
            </View>

            <View
              style={styles.employeeInfo}
            >
              <Text
                style={
                  styles.employeeName
                }
                numberOfLines={1}
              >
                {item.employeeName}
              </Text>

              <Text
                style={
                  styles.employeeMeta
                }
              >
                {item.employeeId}
                {item.department
                  ? `  •  ${item.department}`
                  : ''}
              </Text>
            </View>
          </View>

          <View
            style={styles.pendingBadge}
          >
            <View
              style={styles.pendingDot}
            />

            <Text
              style={styles.pendingText}
            >
              PENDING
            </Text>
          </View>
        </View>

        <View style={styles.divider} />

        {/* TASK TITLE */}
        <View
          style={styles.taskHeaderRow}
        >
          <Ionicons
            name="clipboard-outline"
            size={19}
            color="#E87516"
          />

          <Text
            style={styles.taskTitle}
            numberOfLines={2}
          >
            {item.taskTitle}
          </Text>
        </View>

        {/* DATES */}
        <View style={styles.dateRow}>
          <View style={styles.dateBox}>
            <Text
              style={styles.dateLabel}
            >
              CURRENT DUE DATE
            </Text>

            <Text
              style={styles.dateValue}
            >
              {formatDate(
                item.old_due_date
              )}
            </Text>
          </View>

          <Ionicons
            name="arrow-forward"
            size={18}
            color="#FFFFFF"
            style={styles.dateArrow}
          />

          <View
            style={[
              styles.dateBox,
              styles.requestedDateBox,
            ]}
          >
            <Text
              style={styles.dateLabel}
            >
              REQUESTED DATE
            </Text>

            <Text
              style={
                styles.requestedDateValue
              }
            >
              {formatDate(
                item.requested_due_date
              )}
            </Text>
          </View>
        </View>

        {/* REASON */}
        <View style={styles.reasonBox}>
          <Text
            style={styles.reasonLabel}
          >
            REASON
          </Text>

          <Text
            style={styles.reasonText}
          >
            {item.reason}
          </Text>
        </View>

        <Text style={styles.submittedAt}>
          Requested{' '}
          {formatDateTime(
            item.created_at
          )}
        </Text>

        {/* ACTION BUTTONS */}
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[
              styles.rejectButton,
              isProcessing &&
                styles.disabledButton,
            ]}
            activeOpacity={0.8}
            disabled={!!processingId}
            onPress={() =>
              rejectExtension(
                item.id
              )
            }
          >
            {isProcessing ? (
              <ActivityIndicator
                size="small"
                color="#B42318"
              />
            ) : (
              <Ionicons
                name="close-outline"
                size={18}
                color="#B42318"
              />
            )}

            <Text
              style={
                styles.rejectButtonText
              }
            >
              REJECT
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.approveButton,
              isProcessing &&
                styles.disabledButton,
            ]}
            activeOpacity={0.8}
            disabled={!!processingId}
            onPress={() =>
              approveExtension(
                item.id
              )
            }
          >
            {isProcessing ? (
              <ActivityIndicator
                size="small"
                color="#FFFFFF"
              />
            ) : (
              <Ionicons
                name="checkmark-outline"
                size={18}
                color="#FFFFFF"
              />
            )}

            <Text
              style={
                styles.approveButtonText
              }
            >
              APPROVE
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        {/* HEADER */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.8}
            onPress={() =>
              router.back()
            }
          >
            <Ionicons
              name="arrow-back"
              size={22}
              color="#FFFFFF"
            />
          </TouchableOpacity>

          <View
            style={
              styles.headerTextBlock
            }
          >
            <Text
              style={styles.headerTitle}
            >
              Extension Requests
            </Text>

            <Text
              style={
                styles.headerSubtitle
              }
            >
              Review pending deadline
              changes
            </Text>
          </View>

          <View
            style={styles.headerIconBox}
          >
            <Ionicons
              name="calendar-outline"
              size={21}
              color="#E87516"
            />
          </View>
        </View>

        {/* CONTENT */}
        <ScrollView
          contentContainerStyle={
            styles.scrollContent
          }
          showsVerticalScrollIndicator={
            false
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={
                handleRefresh
              }
              tintColor="#E87516"
            />
          }
        >
          {loading ? (
            <View
              style={styles.centerState}
            >
              <ActivityIndicator
                size="large"
                color="#E87516"
              />

              <Text
                style={
                  styles.centerStateText
                }
              >
                Loading extension
                requests...
              </Text>
            </View>
          ) : requests.length === 0 ? (
            <View
              style={styles.emptyCard}
            >
              <View
                style={
                  styles.emptyIconCircle
                }
              >
                <Ionicons
                  name="checkmark-done-outline"
                  size={30}
                  color="#2E8B57"
                />
              </View>

              <Text
                style={styles.emptyTitle}
              >
                No Pending Requests
              </Text>

              <Text
                style={styles.emptyText}
              >
                There are no extension
                requests waiting for
                your review.
              </Text>

              <TouchableOpacity
                style={
                  styles.refreshButton
                }
                activeOpacity={0.8}
                onPress={
                  handleRefresh
                }
              >
                <Ionicons
                  name="refresh-outline"
                  size={17}
                  color="#FFFFFF"
                />

                <Text
                  style={
                    styles.refreshButtonText
                  }
                >
                  REFRESH
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View
                style={
                  styles.summaryRow
                }
              >
                <View>
                  <Text
                    style={
                      styles.summaryLabel
                    }
                  >
                    PENDING REQUESTS
                  </Text>

                  <Text
                    style={
                      styles.summaryValue
                    }
                  >
                    {requests.length}
                  </Text>
                </View>

                <View
                  style={
                    styles.summaryIconCircle
                  }
                >
                  <Ionicons
                    name="time-outline"
                    size={22}
                    color="#E87516"
                  />
                </View>
              </View>

              {requests.map(
                renderRequestCard
              )}
            </>
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F6F8',
  },

  container: {
    flex: 1,
    backgroundColor: '#F4F6F8',
  },

  header: {
    minHeight: 78,
    paddingHorizontal: 18,
    paddingTop: 55,
    paddingBottom: 22,
    backgroundColor: '#12233F',
    borderBottomWidth: 1,
    borderBottomColor: '#E7EBEF',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },

  backButton: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: '#F4F6F8',
    alignItems: 'center',
    justifyContent: 'center',
  },

  headerTextBlock: {
    flex: 1,
  },

  headerTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '900',
  },

  headerSubtitle: {
    marginTop: 3,
    color: '#7C8795',
    fontSize: 11,
    fontWeight: '600',
  },

  headerIconBox: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: '#FFF0E5',
    alignItems: 'center',
    justifyContent: 'center',
  },

  scrollContent: {
    padding: 16,
    paddingBottom: 34,
  },

  summaryRow: {
    marginBottom: 14,
    padding: 16,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E7EBEF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  summaryLabel: {
    color: '#7C8795',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.7,
  },

  summaryValue: {
    marginTop: 4,
    color: '#182337',
    fontSize: 24,
    fontWeight: '900',
  },

  summaryIconCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#FFF0E5',
    alignItems: 'center',
    justifyContent: 'center',
  },

  requestCard: {
    marginBottom: 14,
    padding: 16,
    borderRadius: 15,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E3E7EB',
    shadowColor: '#132238',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: {
      width: 0,
      height: 3,
    },
    elevation: 2,
  },

  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },

  employeeBlock: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },

  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#12233F',
    alignItems: 'center',
    justifyContent: 'center',
  },

  avatarText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900',
  },

  employeeInfo: {
    flex: 1,
  },

  employeeName: {
    color: '#182337',
    fontSize: 14,
    fontWeight: '900',
  },

  employeeMeta: {
    marginTop: 3,
    color: '#7C8795',
    fontSize: 10,
    fontWeight: '600',
  },

  pendingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#FFF6E9',
    borderWidth: 1,
    borderColor: '#F4D5A0',
    gap: 5,
  },

  pendingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#E87516',
  },

  pendingText: {
    color: '#A45E0A',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  divider: {
    height: 1,
    backgroundColor: '#EDF0F2',
    marginVertical: 14,
  },

  taskHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },

  taskTitle: {
    flex: 1,
    color: '#182337',
    fontSize: 15,
    fontWeight: '900',
    lineHeight: 21,
  },

  dateRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  dateBox: {
    flex: 1,
    minHeight: 70,
    padding: 11,
    borderRadius: 10,
    backgroundColor: '#F4F6F8',
    borderWidth: 1,
    borderColor: '#E6EAEE',
  },

  requestedDateBox: {
    backgroundColor: '#FFF7F0',
    borderColor: '#F4D2B3',
  },

  dateLabel: {
    color: '#7C8795',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  dateValue: {
    marginTop: 8,
    color: '#182337',
    fontSize: 13,
    fontWeight: '800',
  },

  requestedDateValue: {
    marginTop: 8,
    color: '#D9630A',
    fontSize: 13,
    fontWeight: '900',
  },

  dateArrow: {
    marginTop: 8,
  },

  reasonBox: {
    marginTop: 14,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#F8F9FA',
    borderWidth: 1,
    borderColor: '#E8EBEE',
  },

  reasonLabel: {
    color: '#7C8795',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  reasonText: {
    marginTop: 7,
    color: '#303B4C',
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 18,
  },

  submittedAt: {
    marginTop: 10,
    color: '#98A1AC',
    fontSize: 9,
    fontWeight: '600',
  },

  buttonRow: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 10,
  },

  rejectButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5BDB8',
    backgroundColor: '#FFF7F6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },

  rejectButtonText: {
    color: '#B42318',
    fontSize: 11,
    fontWeight: '900',
  },

  approveButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: '#E87516',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },

  approveButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },

  disabledButton: {
    opacity: 0.55,
  },

  centerState: {
    minHeight: 320,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },

  centerStateText: {
    marginTop: 12,
    color: '#7C8795',
    fontSize: 12,
    fontWeight: '600',
  },

  emptyCard: {
    marginTop: 30,
    padding: 26,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E3E7EB',
    alignItems: 'center',
  },

  emptyIconCircle: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: '#EAF7EF',
    alignItems: 'center',
    justifyContent: 'center',
  },

  emptyTitle: {
    marginTop: 14,
    color: '#182337',
    fontSize: 16,
    fontWeight: '900',
  },

  emptyText: {
    marginTop: 7,
    color: '#7C8795',
    fontSize: 11,
    lineHeight: 17,
    textAlign: 'center',
    maxWidth: 280,
  },

  refreshButton: {
    marginTop: 18,
    paddingHorizontal: 18,
    minHeight: 40,
    borderRadius: 10,
    backgroundColor: '#12233F',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },

  refreshButtonText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
});