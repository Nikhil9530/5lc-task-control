import 'react-native-url-polyfill/auto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { createClient } from '@supabase/supabase-js';

/**
 * Supabase config resolution - resilient by design.
 *
 * WHY THIS IS NOT JUST `process.env.EXPO_PUBLIC_*`:
 * `process.env.EXPO_PUBLIC_*` is inlined by Metro at BUILD time. During EAS
 * cloud builds the project is uploaded WITHOUT `.env` (it is gitignored), so
 * those values were `undefined` and every release APK crashed on launch with
 * "supabaseUrl is required" - a crash at import time, inside the root layout
 * render, which is why the app closed instantly with no visible error.
 *
 * Resolution order:
 *   1. `app.json` -> `expo.extra.supabase`  (committed, always shipped)
 *   2. `process.env.EXPO_PUBLIC_*`         (local dev / CI overrides)
 *   3. a clear, actionable error instead of a silent `undefined`
 */
type SupabaseExtra = { url?: string; publishableKey?: string };

const extra = (Constants.expoConfig?.extra ?? {}) as { supabase?: SupabaseExtra };
const fromExtra = extra.supabase ?? {};

const supabaseUrl =
  fromExtra.url ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseKey =
  fromExtra.publishableKey ?? process.env.EXPO_PUBLIC_SUPABASE_KEY ?? '';

// NOTE: this is the PUBLIC anon/publishable key. It is designed to ship inside
// the APK and is NOT a secret - Row Level Security in Postgres is what protects
// the data. NEVER put the service_role key in app.json or anywhere in the app.

if (!supabaseUrl || !supabaseKey) {
  // Loud + specific, instead of createClient()'s opaque "supabaseUrl is required"
  // which killed the app at startup with no diagnosable cause.
  console.error(
    '[supabase] Missing config. Checked app.json -> expo.extra.supabase and ' +
      'EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_KEY. Both were empty.',
  );
  throw new Error(
    'Supabase is not configured. Add expo.extra.supabase.url and ' +
      'expo.extra.supabase.publishableKey to app.json.',
  );
}

/** Base URL for calling Supabase Edge Functions. */
export const supabaseFunctionsUrl = `${supabaseUrl}/functions/v1`;

// ----------------------------------------------------------------------------
// Secure session storage.
// On Android the Supabase session (access + refresh tokens) is stored in
// expo-secure-store, backed by the hardware Keystore - NOT plain storage.
// SecureStore has a ~2KB per-value limit, so larger values are chunked.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Web-only storage.
// @react-native-async-storage/async-storage THROWS the instant it is imported
// when the native module is missing from the running binary (e.g. inside Expo
// Go) - and since every screen imports this file, that one throw took down the
// whole app. It is never used on Android/iOS (the session lives in
// expo-secure-store), so it is now loaded lazily, only in the web branches.
// ----------------------------------------------------------------------------
const webStorage = () =>
  import('@react-native-async-storage/async-storage').then((m) => m.default);

const CHUNK_SIZE = 1800;
const CHUNK_COUNT_KEY = (key: string) => `${key}__chunks`;
const CHUNK_KEY = (key: string, i: number) => `${key}__c${i}`;

async function clearChunks(key: string) {
  const countStr = await SecureStore.getItemAsync(CHUNK_COUNT_KEY(key));
  const count = countStr ? parseInt(countStr, 10) : 0;
  for (let i = 0; i < count; i++) {
    await SecureStore.deleteItemAsync(CHUNK_KEY(key, i));
  }
  await SecureStore.deleteItemAsync(CHUNK_COUNT_KEY(key));
}

const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return (await webStorage()).getItem(key);

    const countStr = await SecureStore.getItemAsync(CHUNK_COUNT_KEY(key));
    if (!countStr) {
      return SecureStore.getItemAsync(key);
    }

    const count = parseInt(countStr, 10);
    if (!count) return null;

    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(CHUNK_KEY(key, i));
      if (part == null) return null;
      parts.push(part);
    }
    return parts.join('');
  },

  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') return (await webStorage()).setItem(key, value);

    await clearChunks(key);
    await SecureStore.deleteItemAsync(key);

    if (value.length <= CHUNK_SIZE) {
      await SecureStore.setItemAsync(key, value);
      return;
    }

    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK_SIZE) {
      chunks.push(value.slice(i, i + CHUNK_SIZE));
    }
    for (let i = 0; i < chunks.length; i++) {
      await SecureStore.setItemAsync(CHUNK_KEY(key, i), chunks[i]);
    }
    await SecureStore.setItemAsync(CHUNK_COUNT_KEY(key), String(chunks.length));
  },

  async removeItem(key: string): Promise<void> {
    if (Platform.OS === 'web') return (await webStorage()).removeItem(key);
    await clearChunks(key);
    await SecureStore.deleteItemAsync(key);
  },
};

// NOTE: this is the PUBLIC anon key. It is designed to ship inside the APK and
// is NOT a secret - Row Level Security in Postgres is what protects the data.
// NEVER put the service_role key in this file or anywhere in the app.
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    storage: secureStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
