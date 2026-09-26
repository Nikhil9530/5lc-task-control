import { router } from 'expo-router';
import { supabase } from './supabase';

// ----------------------------------------------------------------------------
// Cached session identity — one secure-storage read per launch, not per screen.
// ----------------------------------------------------------------------------
// `supabase.auth.getUser()` hits the AUTH SERVER over the network on every
// call. `getSession()` only reads local storage. Screens used to call
// getUser() one after another, so opening the app meant 3-4 sequential network
// round-trips before anything painted - the 2-second "laggy" feeling.
// getMyId() resolves the user id once and memoizes it; every screen under it
// just awaits the same promise. It also fires-and-forgets a background
// getUser() refresh so the cached token stays warm without blocking the UI.
// ----------------------------------------------------------------------------
let cachedUserId: string | null = null;
let userIdPromise: Promise<string | null> | null = null;
let warmed = false;

async function resolveUserId(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const id = session?.user?.id ?? null;
  cachedUserId = id;

  // Warm the auth cache once per app launch. This is the call that used to
  // block the first screen; now it runs behind the UI instead of before it.
  if (id && !warmed) {
    warmed = true;
    supabase.auth.getUser().catch(() => {});
  }

  return id;
}

// Fast path: the signed-in user's id, cached after the first call.
export function getMyId(): Promise<string | null> {
  if (cachedUserId) return Promise.resolve(cachedUserId);
  if (!userIdPromise) {
    userIdPromise = resolveUserId().finally(() => {
      userIdPromise = null;
    });
  }
  return userIdPromise;
}

// The current signed-in user's profile (id, role, hierarchy links), or null.
//
// Uses getMyId() (local session read) instead of getUser() (auth-server
// round-trip). getUser() is only warmed once per launch, in the background,
// so screens never queue behind it.
export async function getCurrentProfile() {
  const userId = await getMyId();

  if (!userId) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select(
      'id, employee_id, full_name, email, role, department, manager_id, director_id, is_active'
    )
    .eq('id', userId)
    .single();

  if (error) {
    console.log('getCurrentProfile error:', error.message);
    return null;
  }

  return data;
}

// ----------------------------------------------------------------------------
// Shared identity cache - one profile read for the whole session.
// ----------------------------------------------------------------------------
// getCurrentProfile() hits `profiles` over the network. Dashboard, tasks,
// team and member-tasks each needed it on open, so the same row was fetched
// 3-4 times per app launch. This caches the row in memory (per user id), plus
// a promise-dedupe so two screens mounting at once still cause ONE request.
// signOut() clears this via clearSessionCache().
// ----------------------------------------------------------------------------
export type SessionProfile = {
  id: string;
  employee_id: string | null;
  full_name: string | null;
  email: string | null;
  role: string;
  department: string | null;
  manager_id: string | null;
  director_id: string | null;
  is_active: boolean | null;
};

let cachedSessionProfile: SessionProfile | null = null;
let cachedSessionProfileFor: string | null = null;
let sessionProfilePromise: Promise<SessionProfile | null> | null = null;

async function resolveSessionProfile(): Promise<SessionProfile | null> {
  const profile = await getCurrentProfile();

  if (profile && cachedUserId) {
    cachedSessionProfile = profile as SessionProfile;
    cachedSessionProfileFor = cachedUserId;
  }

  return (profile as SessionProfile | null) ?? null;
}

// Fast path: the caller's profile, fetched once and shared by all screens.
export function getSessionProfile(): Promise<SessionProfile | null> {
  const userId = cachedUserId;

  if (
    userId &&
    cachedSessionProfile &&
    cachedSessionProfileFor === userId
  ) {
    return Promise.resolve(cachedSessionProfile);
  }

  if (!sessionProfilePromise) {
    sessionProfilePromise = resolveSessionProfile().finally(() => {
      sessionProfilePromise = null;
    });
  }

  return sessionProfilePromise;
}

// Sign out and return to the login screen.
export async function signOut() {
  try {
    await supabase.auth.signOut();
  } catch (e) {
    console.log('signOut error:', e);
  } finally {
    clearSessionCache();
    router.replace('/');
  }
}

// Drop cached identity so the next sign-in re-resolves from storage.
export function clearSessionCache() {
  cachedUserId = null;
  userIdPromise = null;
  warmed = false;
  cachedSessionProfile = null;
  cachedSessionProfileFor = null;
  sessionProfilePromise = null;
}
