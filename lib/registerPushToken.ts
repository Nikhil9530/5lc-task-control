import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { supabase } from './supabase';

// Remote push (FCM) is NOT available inside Expo Go (removed in SDK 53+).
// The app must run as a development/production build for push to work.
function isExpoGo(): boolean {
  return (
    (Constants as any).executionEnvironment === 'storeClient' ||
    (Constants as any).appOwnership === 'expo'
  );
}

export async function registerPushToken(userId: string) {
  try {
    // Web browsers do not use the native FCM/APNs token flow.
    if (Platform.OS === 'web') {
      return;
    }

    // Expo Go cannot receive remote push - skip cleanly instead of erroring.
    if (isExpoGo()) {
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
      await Notifications.setNotificationChannelAsync(
        'default',
        {
          name: 'Default',
          importance:
            Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250],
          lockscreenVisibility:
            Notifications.AndroidNotificationVisibility.PUBLIC,
        }
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