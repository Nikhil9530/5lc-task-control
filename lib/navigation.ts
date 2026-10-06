import { router, type Href } from 'expo-router';

/**
 * Tap-guarded navigation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every screen used `router.push(...)` straight from a `TouchableOpacity`
 * `onPress`. A tap fires `onPress` immediately; a fast DOUBLE tap therefore
 * pushed the SAME screen twice, stacking two identical routes. Pressing back
 * then popped one, showing the same screen again - which is why back felt like
 * it "went back twice" and the app felt cheap.
 *
 * HOW IT WORKS
 * ------------
 * A short per-destination lock. The second tap on the SAME destination inside
 * the window is swallowed, while a tap on a DIFFERENT destination still works
 * instantly - so this never feels unresponsive, it just ignores accidental
 * double taps. The lock is module scope, so it also holds across re-renders.
 *
 * Use `nav()` / `navReplace()` / `goBack()` instead of calling `router`
 * directly from any user-tap handler.
 */

/** How long a destination stays "locked" after a push (ms). */
const TAP_LOCK_MS = 700;

const lastNavAt = new Map<string, number>();
let lastBackAt = 0;

function destinationKey(href: Href): string {
  return typeof href === 'string' ? href : JSON.stringify(href);
}

/**
 * Push a route, ignoring an accidental repeat tap on the same destination.
 * Safe to call from `onPress` directly.
 */
export function nav(href: Href): void {
  const key = destinationKey(href);
  const now = Date.now();

  if (now - (lastNavAt.get(key) ?? 0) < TAP_LOCK_MS) return;

  lastNavAt.set(key, now);
  router.push(href);
}

/**
 * Replace the current route, ignoring an accidental repeat tap on the same
 * destination. Use for "leave this screen for good" flows (post-login,
 * post-save) rather than ordinary forward navigation.
 */
export function navReplace(href: Href): void {
  const key = `replace:${destinationKey(href)}`;
  const now = Date.now();

  if (now - (lastNavAt.get(key) ?? 0) < TAP_LOCK_MS) return;

  lastNavAt.set(key, now);
  router.replace(href);
}

/**
 * Auth-redirect de-duplication.
 *
 * WHY: after a successful sign-in, `signInWithPassword` fires supabase's
 * SIGNED_IN event AND the login screen navigates itself. Both the root-layout
 * auth gate and the login screen therefore wanted to call
 * router.replace('/dashboard') inside the same tick, so the transition ran
 * twice - a visible double "pop" right after signing in.
 *
 * The first caller claims the "<destination>|<origin>" key and navigates; the
 * second sees the claim already taken and stands down. Because the origin is
 * part of the key, a genuine later state change (signing out from the
 * dashboard, for example) still navigates normally.
 */
let lastAuthRedirect: string | null = null;

/** Returns true if this caller won the right to perform the redirect. */
export function claimAuthRedirect(target: Href, from: string): boolean {
  const key = `${destinationKey(target)}|${from}`;

  if (lastAuthRedirect === key) return false;

  lastAuthRedirect = key;
  return true;
}

/**
 * Go back one screen, ignoring an accidental repeat tap.
 *
 * This is locked globally (not per-destination) because "back" has no
 * destination - two fast taps would otherwise pop two screens and skip past
 * the screen the user wanted to return to.
 *
 * FALLBACK: screens opened from the bottom nav use `navReplace()`, which
 * REPLACES the dashboard instead of stacking on top of it - so the stack can
 * hold nothing but the current screen (`canGoBack() === false`). `router.back()`
 * then has no target and silently does nothing, which is why the Settings
 * back button appeared dead. In that case we replace to the dashboard, the
 * hub every role returns to, rather than leaving a dead button. `replace`
 * (not `push`) so the empty-history state cannot stack up.
 */
export function goBack(): void {
  const now = Date.now();

  if (now - lastBackAt < TAP_LOCK_MS) return;

  lastBackAt = now;

  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/dashboard');
  }
}
