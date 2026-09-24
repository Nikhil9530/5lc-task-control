import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import { supabase } from '../../lib/supabase';

// Routes anyone may open without being signed in.
// (undefined = index/login screen)
const PUBLIC_ROUTES = ['forgot-password'];

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();

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

  return <Stack screenOptions={{ headerShown: false }} />;
}
