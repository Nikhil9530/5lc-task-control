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
 * Go back one screen, ignoring an accidental repeat tap.
 *
 * This is locked globally (not per-destination) because "back" has no
 * destination - two fast taps would otherwise pop two screens and skip past
 * the screen the user wanted to return to.
 */
export function goBack(): void {
  const now = Date.now();

  if (now - lastBackAt < TAP_LOCK_MS) return;

  lastBackAt = now;
  router.back();
}
