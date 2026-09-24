import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_KEY!;

// ----------------------------------------------------------------------------
// Secure session storage.
// On Android the Supabase session (access + refresh tokens) is stored in
// expo-secure-store, backed by the hardware Keystore - NOT plain storage.
// SecureStore has a ~2KB per-value limit, so larger values are chunked.
// ----------------------------------------------------------------------------

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
    if (Platform.OS === 'web') return AsyncStorage.getItem(key);

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
    if (Platform.OS === 'web') return AsyncStorage.setItem(key, value);

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
    if (Platform.OS === 'web') return AsyncStorage.removeItem(key);
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
