/**
 * Notification hygiene helper.
 *
 * WHY THIS EXISTS
 * ---------------
 * Push notifications arrived and then STAYED in the Android tray forever, and
 * the launcher badge never went down. Nothing in the app ever called
 * dismissNotificationAsync() / dismissAllNotificationsAsync(), so the only way
 * a notification disappeared was the user manually swiping it away.
 *
 * This module owns the three things that were missing:
 *   1. dismissing tray entries (all of them, or just the acknowledged ones)
 *   2. clearing the app badge
 *   3. correlating a tray entry back to its row in public.notifications
 *
 * The correlation works through `data.notificationId`, which
 * supabase/functions/dispatch-notifications now puts in the FCM payload.
 * Notifications sent BEFORE that change have no notificationId in their data,
 * so they are matched loosely: if the user has no unread notifications left,
 * every presented tray entry is treated as stale.
 *
 * expo-notifications is imported lazily so the native module is never touched
 * on web or in Expo Go (where remote push is unavailable).
 */

import { Platform } from 'react-native';
import { supabase } from './supabase';

type NotificationsApi = typeof import('expo-notifications');

type PresentedNotification = Awaited<
  ReturnType<NotificationsApi['getPresentedNotificationsAsync']>
>[number];

let cached: NotificationsApi | null = null;
let loading: Promise<NotificationsApi | null> | null = null;
let unavailable = false;

async function load(): Promise<NotificationsApi | null> {
  try {
    const mod = await import('expo-notifications');
    cached = mod;
    return mod;
  } catch {
    // Native module missing (web / Expo Go) - hygiene calls become no-ops.
    unavailable = true;
    return null;
  }
}

async function api(): Promise<NotificationsApi | null> {
  if (Platform.OS === 'web' || unavailable) return null;
  if (cached) return cached;
  if (loading) return loading;

  loading = load();
  return loading;
}

/** The notificationId carried in the FCM payload, if present. */
function notificationIdOf(item: PresentedNotification): string | null {
  const data = item.request.content.data as
    | Record<string, unknown>
    | null
    | undefined;

  const value = data?.notificationId;

  return typeof value === 'string' && value ? value : null;
}

async function presented(): Promise<PresentedNotification[]> {
  const N = await api();
  if (!N) return [];

  try {
    return await N.getPresentedNotificationsAsync();
  } catch {
    return [];
  }
}

/** Clear the launcher badge. Safe to call even when no badge is set. */
export async function clearAppBadge(): Promise<void> {
  const N = await api();
  if (!N) return;

  try {
    await N.setBadgeCountAsync(0);
  } catch {
    // Badge support varies by launcher - never let this break a screen.
  }
}

/** Remove every notification from the Android tray. */
export async function dismissAllTrayEntries(): Promise<void> {
  const N = await api();
  if (!N) return;

  try {
    await N.dismissAllNotificationsAsync();
  } catch {
    // Nothing presented, or the API is unsupported on this platform.
  }
}

/**
 * Remove the tray entries that correspond to the given notification ids.
 * Entries with no notificationId in their payload cannot be matched here.
 */
export async function dismissTrayEntriesForIds(
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;

  const N = await api();
  if (!N) return;

  const wanted = new Set(ids);
  const items = await presented();

  const matches = items.filter((item) => {
    const id = notificationIdOf(item);
    return id !== null && wanted.has(id);
  });

  await Promise.all(
    matches.map(async (item) => {
      try {
        await N.dismissNotificationAsync(item.request.identifier);
      } catch {
        // Already dismissed - ignore.
      }
    })
  );
}

/**
 * Reconcile the tray with the inbox.
 *
 * Anything still shown that the user has already read is removed, and if there
 * is nothing unread left at all the tray is cleared and the badge reset. This
 * is what makes a handled notification actually disappear instead of lingering
 * for days.
 *
 * Returns false when the unread list could not be read (offline), in which case
 * nothing is dismissed - we never guess.
 */
export async function syncTrayWithInbox(): Promise<boolean> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id')
    .eq('is_read', false)
    .limit(200);

  if (error) {
    console.log(
      'Notification tray sync skipped:',
      error.message
    );

    return false;
  }

  const unread = new Set(
    (data ?? []).map((row) => row.id as string)
  );

  const items = await presented();

  // Nothing unread anywhere -> nothing should be left in the tray.
  if (unread.size === 0) {
    if (items.length > 0) {
      await dismissAllTrayEntries();
    }

    await clearAppBadge();
    return true;
  }

  const stale = items.filter((item) => {
    const id = notificationIdOf(item);

    // No id in the payload (sent before the dispatch function was updated):
    // leave it alone rather than risk dismissing a live obligation.
    if (id === null) return false;

    return !unread.has(id);
  });

  await Promise.all(
    stale.map(async (item) => {
      try {
        const N = await api();
        await N?.dismissNotificationAsync(item.request.identifier);
      } catch {
        // Already dismissed - ignore.
      }
    })
  );

  await clearAppBadge();
  return true;
}

/**
 * Acknowledge notifications, then remove their tray entries and reset the badge.
 *
 * `ids` = null acknowledges everything ("Mark all read").
 * Returns the number of rows actually flipped to read.
 */
export async function acknowledgeNotifications(
  ids: string[] | null
): Promise<number> {
  const { data, error } = await supabase.rpc(
    'mark_notifications_read',
    { p_ids: ids }
  );

  if (error) {
    throw new Error(error.message);
  }

  if (ids && ids.length > 0) {
    await dismissTrayEntriesForIds(ids);
  } else {
    await dismissAllTrayEntries();
  }

  await clearAppBadge();

  return typeof data === 'number' ? data : 0;
}

/** Delete the caller's already-read notifications. Returns rows removed. */
export async function clearReadNotifications(): Promise<number> {
  const { data, error } = await supabase.rpc(
    'clear_read_notifications'
  );

  if (error) {
    throw new Error(error.message);
  }

  await syncTrayWithInbox();

  return typeof data === 'number' ? data : 0;
}
