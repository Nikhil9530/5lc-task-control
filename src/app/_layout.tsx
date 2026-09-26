import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  hydrateDashboardCache,
  waitForFirstDashboardPaint,
} from '../../lib/dashboardCache';
import { claimAuthRedirect } from '../../lib/navigation';
import { supabase } from '../../lib/supabase';
import { useNotificationRouter } from '../../lib/useNotificationRouter';

// Routes anyone may open without being signed in.
// (undefined = index/login screen)
const PUBLIC_ROUTES = ['forgot-password'];

// How long we are willing to hold the splash waiting for the dashboard's first
// real paint, and the absolute failsafe if session restore itself stalls.
const FIRST_PAINT_BUDGET_MS = 1200;
const SPLASH_FAILSAFE_MS = 3500;

// ----------------------------------------------------------------------------
// COLD START
//
// The old flow mounted <Stack /> immediately, which rendered the index/login
// route while the session was still unknown. getSession() then resolved, guard()
// saw "session && segments[0] === undefined" and called router.replace(),
// so every cold start showed: LOGIN FLASH -> BLANK -> DASHBOARD -> DASHBOARD
// repainting when the network answered.
//
// The fix is NOT to render null (that unmounts the navigator, so router.replace
// has no navigation ref to act on - it silently no-ops - and it just swaps the
// login flash for a blank screen). Instead we keep the navigator MOUNTED so
// routing works, and hold the NATIVE splash on top of it until the session is
// known and the first real frame is ready. The login screen renders underneath
// the splash, where it cannot be seen.
// ----------------------------------------------------------------------------
SplashScreen.preventAutoHideAsync().catch(() => {});

let splashHidden = false;

function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  SplashScreen.hideAsync().catch(() => {});
}


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

  // Resolved once, from the very first render. "Where the app was headed when
  // it launched" - the login index on a normal cold start, or a deep-linked
  // route when a notification/email link opened the app.
  const startRoute = useRef(segments[0]);

  // Session restore result. `ready` gates the splash, `hasSession` decides
  // whether we are going to the dashboard (and therefore whether it is worth
  // waiting for that screen's first paint).
  const [boot, setBoot] = useState({ ready: false, hasSession: false });

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
  //
  // Split into two effects on purpose:
  //   A. BOOTSTRAP (mount only) - hydrate the dashboard cache, resolve the
  //      session, redirect exactly once, then release the splash.
  //   B. ONGOING (authReady + segments) - keep signing in/out and deep links
  //      honest afterwards.
  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      // Parallel: a local AsyncStorage read and a local secure-storage read.
      // Doing the cache first means the dashboard's very first frame already
      // has the last-known numbers instead of zeros.
      const [{ data }] = await Promise.all([
        supabase.auth.getSession(),
        hydrateDashboardCache(),
      ]);

      if (!mounted) return;

      const session = data.session;
      const current = startRoute.current;

      // Redirect once. If the app was opened on a real route (deep link from a
      // notification or a reset email) we stay put and let that screen render.
      // claimAuthRedirect() makes this a no-op if something else got there
      // first, so the transition can never run twice.
      if (session) {
        if (current === undefined && claimAuthRedirect('/dashboard', 'index')) {
          router.replace('/dashboard');
        }
      } else if (
        current !== undefined &&
        !PUBLIC_ROUTES.includes(current) &&
        claimAuthRedirect('/', current)
      ) {
        router.replace('/');
      }

      setBoot({ ready: true, hasSession: !!session });
    }

    bootstrap();

    return () => {
      mounted = false;
    };
  }, []);

  // ---- SPLASH RELEASE ------------------------------------------------------
  // The splash is what hides the login route during session restore. It comes
  // down when we know where we are, and - when that destination is the
  // dashboard - once the dashboard has real numbers on screen, so the first
  // thing the user sees is the finished screen.
  useEffect(() => {
    if (!boot.ready) return;

    // Signed in and launching into the dashboard: give its first load a
    // moment to land, but never block on it.
    if (boot.hasSession && startRoute.current === undefined) {
      let cancelled = false;

      waitForFirstDashboardPaint(FIRST_PAINT_BUDGET_MS).then(() => {
        if (!cancelled) hideSplash();
      });

      return () => {
        cancelled = true;
      };
    }

    // No session (login is the correct screen), or a deep link took us
    // somewhere specific - show the app immediately.
    hideSplash();
  }, [boot.ready, boot.hasSession]);

  // Absolute failsafe: if getSession() itself never settles, the user must not
  // be trapped staring at the splash.
  useEffect(() => {
    const failsafe = setTimeout(hideSplash, SPLASH_FAILSAFE_MS);
    return () => clearTimeout(failsafe);
  }, []);

  // ---- ONGOING AUTH GATE ---------------------------------------------------
  useEffect(() => {
    if (!boot.ready) return;

    let mounted = true;

    const guard = (session: unknown) => {
      if (!mounted) return;

      const current = segments[0];
      const isPublic = current === undefined || PUBLIC_ROUTES.includes(current);

      // Typed routes: the target must stay a literal union, not `string`.
      let target: '/' | '/dashboard' | null = null;

      if (!session && !isPublic) {
        target = '/';
      } else if (session && current === undefined) {
        target = '/dashboard';
      }

      if (!target) return;

      // Same destination from the same origin = a duplicate trigger (supabase's
      // INITIAL_SESSION event, or the login screen's own navigation), not a real
      // state change. Replacing again would restart the transition.
      if (!claimAuthRedirect(target, current ?? 'index')) return;

      router.replace(target);
    };

    // Subscribing AFTER the bootstrap getSession() has resolved is what stops
    // INITIAL_SESSION from firing a second redirect on a cold start.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      guard(session);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [boot.ready, segments]);

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
