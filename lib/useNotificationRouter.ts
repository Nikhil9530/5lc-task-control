/**
 * Notification tap router + tray reconciler.
 *
 * WHY THIS EXISTS
 * ---------------
 * There was no tap listener anywhere in the app, so tapping a push notification
 * did nothing at all: it just opened the app, and the tray entry stayed there
 * forever. This hook supplies the missing behaviour.
 *
 * WHAT IT DOES
 * ------------
 *  1. COLD START - if the app was launched by a tap, handle that response.
 *  2. WARM TAP   - handle taps while the app is already running.
 *  3. ACKNOWLEDGE - mark the row read, then remove that exact tray entry and
 *     reset the badge. This is the step that makes a handled notification
 *     actually disappear.
 *  4. FOREGROUND - when the app returns to the foreground, reconcile the tray
 *     against the inbox so anything already read is cleared.
 *
 * ROUTING
 * -------
 * extension notifications -> the Extensions screen
 * task notifications      -> that task's detail screen (data.taskId)
 * anything else           -> stay put; acknowledging is still enough
 *
 * Navigation is skipped when there is no session, because the auth gate in
 * _layout would bounce the user straight back to login anyway.
 */

import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { nav } from './navigation';
import {
  clearAppBadge,
  dismissTrayEntriesForIds,
  syncTrayWithInbox,
} from './notificationCenter';
import { supabase } from './supabase';

function stringField(
  data: Record<string, unknown>,
  key: string
): string | null {
  const value = data[key];

  return typeof value === 'string' && value ? value : null;
}

/**
 * Fallback for pushes sent before the dispatch function started including
 * `notificationId`: locate the unread row for this task so it can be
 * acknowledged and its tray entry removed.
 */
async function notificationIdsForTask(
  taskId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id')
    .eq('task_id', taskId)
    .eq('is_read', false)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) return [];

  return (data ?? []).map((row) => row.id as string);
}

async function acknowledge(
  notificationId: string | null,
  taskId: string | null
): Promise<void> {
  if (notificationId) {
    await supabase.rpc('mark_notifications_read', {
      p_ids: [notificationId],
    });

    await dismissTrayEntriesForIds([notificationId]);
    await clearAppBadge();
    return;
  }

  if (taskId) {
    const ids = await notificationIdsForTask(taskId);

    if (ids.length > 0) {
      await supabase.rpc('mark_notifications_read', {
        p_ids: ids,
      });

      await dismissTrayEntriesForIds(ids);
      await clearAppBadge();
      return;
    }
  }

  // Last resort: reconcile the whole tray with the inbox.
  await syncTrayWithInbox();
}

export function useNotificationRouter(): void {
  useEffect(() => {
    if (Platform.OS === 'web') return;

    let cancelled = false;
    const handledResponses = new Set<string>();

    async function handle(
      response: Notifications.NotificationResponse
    ): Promise<void> {
      const request = response.notification.request;

      // The same response can reach us twice (cold-start read + listener).
      const key = `${request.identifier}:${response.actionIdentifier}`;

      if (handledResponses.has(key)) return;

      handledResponses.add(key);

      try {
        const data = (request.content.data ?? {}) as Record<
          string,
          unknown
        >;

        const notificationId = stringField(data, 'notificationId');
        const taskId = stringField(data, 'taskId');
        const extensionId = stringField(data, 'extensionId');

        await acknowledge(notificationId, taskId);

        if (cancelled) return;

        const { data: session } = await supabase.auth.getSession();

        if (!session.session) return;

        if (extensionId) {
          nav('/extensions');
          return;
        }

        if (taskId) {
          nav({ pathname: '/task-detail', params: { id: taskId } });
        }
      } catch (error) {
        console.log('Notification tap handling failed:', error);
      }
    }

    // 1. Cold start: the app may have been launched by a tap.
    try {
      const last = Notifications.getLastNotificationResponse();

      if (last) {
        // Clear it so a later re-render cannot replay the same navigation.
        Notifications.clearLastNotificationResponse();
        void handle(last);
      }
    } catch {
      // Native module unavailable - nothing to replay.
    }

    // 2. Warm taps. Wrapped because the native module is absent in Expo Go;
    // there, taps simply do nothing instead of crashing this effect.
    let responseSub: { remove: () => void } | null = null;

    try {
      responseSub = Notifications.addNotificationResponseReceivedListener(
        (response) => {
          void handle(response);
        }
      );
    } catch {
      // No native module - no tap handling.
    }

    // 3. Anything already read should not still be sitting in the tray. The
    //    inbox screen also does this on load; doing it on foreground means the
    //    tray is clean before the user even opens that screen.
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void syncTrayWithInbox();
      }
    });

    return () => {
      cancelled = true;
      responseSub?.remove();
      appSub.remove();
    };
  }, []);
}
