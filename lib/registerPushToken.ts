import { isRunningInExpoGo } from 'expo';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { supabase } from './supabase';

// Remote push (FCM) is NOT available inside Expo Go (removed in SDK 53+).
// The app must run as a development/production build for push to work.
//
// isRunningInExpoGo() is the official check - it is true only when the native
// ExpoGo module is present, and it is the same helper expo-notifications itself
// uses. The previous hand-rolled Constants.executionEnvironment / appOwnership
// check silently returned false inside Expo Go on SDK 57, so execution ran on
// to getDevicePushTokenAsync() and threw there instead of skipping cleanly.

let registrationPromise: Promise<void> | null = null;
export async function registerPushToken(userId: string) {
  if (registrationPromise) {
    return registrationPromise;
  }

  registrationPromise = registerPushTokenInternal(userId);

  try {
    await registrationPromise;
  } finally {
    registrationPromise = null;
  }
}

async function registerPushTokenInternal(userId: string) {
  try {
    // Web browsers do not use the native FCM/APNs token flow.    if (Platform.OS === 'web') {
    if (Platform.OS === 'web') {
      return;
    }

    // Expo Go cannot receive remote push - skip cleanly instead of erroring.
    if (isRunningInExpoGo()) {
      console.log(
        'Push registration skipped: Expo Go cannot receive push. Use a development build to test notifications.'
      );
      return;
    }

    // Push notifications require a real device/build.
    if (!Device.isDevice) {
      console.log(
        'Push token registration skipped: not a physical device.'
      );
      return;
    }

    // expo-notifications is loaded only when actually registering a token.
    // (Keeps Expo Go from touching the native module at all.)
    const Notifications = await import('expo-notifications');

    // Android notification channel must exist
    // before requesting the native push token.
    if (Platform.OS === 'android') {
      // Channel ID is 'default_v2' (not 'default'). Android channels are
      // IMMUTABLE once created: the old 'default' channel was created WITHOUT
      // a sound, so re-setting it could never add sound later. A new channel
      // ID is the only way to get an audible channel on existing installs.
      await Notifications.setNotificationChannelAsync(
        'default_v2',
        {
          name: 'Default',
          importance:
            Notifications.AndroidImportance.MAX,

          // 'default' = the device's system notification sound.
          //
          // NOTE: expo-notifications logs a red "Custom sound 'default' not
          // found in native app" error for this. That error is HARMLESS NOISE:
          // the native SoundResolver falls back to
          // Settings.System.DEFAULT_NOTIFICATION_URI when no bundled raw
          // resource matches, so the channel DOES get the default sound.
          // Do NOT "fix" it by removing this line - that recreates the
          // permanently-silent-channel bug.
          sound: 'default',

          enableVibrate: true,
          showBadge: true,
          vibrationPattern: [0, 250, 250, 250],
          lockscreenVisibility:
            Notifications.AndroidNotificationVisibility.PUBLIC,
        }
      );

      // Clean up the legacy silent channel so it stops appearing in Settings.
      try {
        await Notifications.deleteNotificationChannelAsync('default');
      } catch {
        // Channel may not exist (fresh install) - nothing to clean up.
      }

      // Proof in the logs: read back what Android actually stored for the
      // new channel. Look for this line right AFTER the red
      // "Custom sound 'default'" error - it should show "default_v2" with
      // sound "default". If you only see the red error WITHOUT this line,
      // you are running a stale bundle and the new code never executed.
      const channel =
        await Notifications.getNotificationChannelAsync('default_v2');
      console.log(
        'Push channel default_v2:',
        JSON.stringify(channel)
      );
    }

    // Check notification permission.
    const {
      status: existingStatus,
    } =
      await Notifications.getPermissionsAsync();

    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const {
        status,
      } =
        await Notifications.requestPermissionsAsync();

      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log(
        'Notification permission was not granted.'
      );
      return;
    }

    // Get the native FCM/APNs token.
    const deviceToken =
      await Notifications.getDevicePushTokenAsync();

    const token = deviceToken?.data;

    if (!token) {
      console.log(
        'No native device push token returned.'
      );
      return;
    }

    const platform =
      Platform.OS === 'android'
        ? 'android'
        : 'ios';

    // Save / update token in Supabase.
    const { error } =
      await supabase
        .from('device_tokens')
        .upsert(
          {
            user_id: userId,
            token,
            platform,
            device_name:
              Device.deviceName || null,
            is_active: true,
            updated_at:
              new Date().toISOString(),
          },
          {
            onConflict:
              'user_id,token',
          }
        );

    if (error) {
      console.error(
        'Device token save error:',
        error.message
      );
      return;
    }

    console.log(
      `Push token registered for ${platform}`
    );
  } catch (error) {
    console.error(
      'Push token registration error:',
      error
    );
  }
}