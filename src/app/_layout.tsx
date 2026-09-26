import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter, useSegments } from 'expo-router';
import React from 'react';
import { useEffect } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../../lib/supabase';
import { useNotificationRouter } from '../../lib/useNotificationRouter';

// Routes anyone may open without being signed in.
// (undefined = index/login screen)
const PUBLIC_ROUTES = ['forgot-password'];

/**
 * Last line of defence.
 *
 * Without this, ANY render-time throw in the root layout kills the Android
 * process instantly and the app just "closes" with no explanation - exactly
 * what happened when the Supabase config was missing from release builds.
 * This catches render errors and shows them instead of dying silently.
 *
 * NOTE: this cannot catch a throw that happens while `../../lib/supabase` is
 * being *imported* (that runs before any component mounts). Config resolution
 * lives in lib/supabase.ts for that reason.
 */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[RootErrorBoundary]', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <ScrollView contentContainerStyle={styles.errWrap}>
        <Text style={styles.errTitle}>Something went wrong</Text>
        <Text style={styles.errMsg}>{error.message}</Text>
        <Text style={styles.errHint}>
          This is a bug in the app. Please send this message to the developer.
        </Text>
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  errWrap: { flexGrow: 1, padding: 24, paddingTop: 80, justifyContent: 'center' },
  errTitle: { fontSize: 20, fontWeight: '700', color: '#B00020', marginBottom: 12 },
  errMsg: { fontSize: 14, color: '#333', marginBottom: 16, lineHeight: 20 },
  errHint: { fontSize: 12, color: '#888' },
});

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();

  // Tapping a push notification navigates to the right screen AND removes that
  // notification from the Android tray. Without this the tray entry stayed
  // forever, which is why days-old notifications were still visible.
  useNotificationRouter();

    // ---- NATIVE PUSH NOTIFICATIONS ------------------------------------------
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });
  }, []);

  // ---- AUTH GATE -----------------------------------------------------------
  // Every screen except login + forgot-password requires a valid session.
  // This is a UX guard only - the real boundary is Postgres RLS.
  useEffect(() => {
    const guard = (session: unknown) => {
      const current = segments[0];
      const isPublic = current === undefined || PUBLIC_ROUTES.includes(current);

      if (!session && !isPublic) {
        router.replace('/');
      } else if (session && current === undefined) {
        // Already signed in and sitting on the login screen -> go to work.
        router.replace('/dashboard');
      }
    };

    supabase.auth.getSession().then(({ data }) => guard(data.session));

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      guard(session);
    });

    return () => sub.subscription.unsubscribe();
  }, [segments]);

  // ---- DEEP LINKS (invite / password-reset emails) -------------------------
  // Links like flctaskcontrol://reset#access_token=... or ?code=... open the
  // app; we exchange them for a session here.
  useEffect(() => {
    async function handleUrl(url: string | null) {
      if (!url) return;
      try {
        const { queryParams } = Linking.parse(url);
        const code = queryParams?.code;
        if (typeof code === 'string' && code) {
          await supabase.auth.exchangeCodeForSession(code);
          return;
        }
        const hash = url.split('#')[1];
        if (hash) {
          const params = new URLSearchParams(hash);
          const access_token = params.get('access_token');
          const refresh_token = params.get('refresh_token');
          if (access_token && refresh_token) {
            await supabase.auth.setSession({ access_token, refresh_token });
          }
        }
      } catch (e) {
        console.log('Deep-link auth error:', e);
      }
    }

    Linking.getInitialURL().then(handleUrl);
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => sub.remove();
  }, []);

  return (
    <RootErrorBoundary>
      <Stack screenOptions={{ headerShown: false }} />
    </RootErrorBoundary>
  );
}
