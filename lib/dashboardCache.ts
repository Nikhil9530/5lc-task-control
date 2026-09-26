import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Dashboard cache.
 *
 * WHY: the dashboard used to seed itself from module-scope variables, which
 * only live as long as the JS process. On a COLD START the process was killed,
 * so that cache was ALWAYS empty: the screen painted zeros + the "Super Admin"
 * placeholder and then visibly repainted when the network answered - the second
 * "pop" the user reported.
 *
 * The last-known payload is now mirrored into AsyncStorage, so a cold start can
 * paint real numbers on the very first frame. _layout.tsx awaits
 * hydrateDashboardCache() behind the splash screen, so this local read is always
 * finished before the first frame the user sees.
 */

const STORAGE_KEY = 'flc.dashboard.cache.v1';

export type DashboardCounts = {
  active: number;
  due_today: number;
  overdue: number;
  completed_today: number;
  not_started: number;
  in_progress: number;
  waiting: number;
};

export type DashboardUser = {
  fullName: string;
  role: string;
};

export type DashboardCache = {
  counts: DashboardCounts | null;
  user: DashboardUser | null;
  unread: boolean;
};

let memory: DashboardCache = { counts: null, user: null, unread: false };
let hydrated = false;
let dirty = false;
let hydratePromise: Promise<DashboardCache> | null = null;

// Resolved by the dashboard once its first load settles. The layout races this
// against a timeout so a slow (or offline) network can never hold the splash
// screen hostage.
let firstPaintSignalled = false;
let resolveFirstPaint: () => void = () => {};
const firstPaint = new Promise<void>((resolve) => {
  resolveFirstPaint = resolve;
});

export function markFirstDashboardPaint() {
  if (firstPaintSignalled) return;
  firstPaintSignalled = true;
  resolveFirstPaint();
}

export function waitForFirstDashboardPaint(timeoutMs: number): Promise<void> {
  return Promise.race([
    firstPaint,
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}

export function getDashboardCache(): DashboardCache {
  return memory;
}

export function isDashboardCacheHydrated(): boolean {
  return hydrated;
}

export function hydrateDashboardCache(): Promise<DashboardCache> {
  if (hydratePromise) return hydratePromise;

  hydratePromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);

      // If live data already arrived while we were reading the disk copy, that
      // data is newer - never let the stored copy overwrite it.
      if (raw && !dirty) {
        const parsed = JSON.parse(raw) as Partial<DashboardCache>;

        memory = {
          counts: parsed.counts ?? null,
          user: parsed.user ?? null,
          unread: parsed.unread === true,
        };
      }
    } catch (e) {
      // A missing or corrupt cache must never block startup.
      console.log('Dashboard cache hydrate failed:', e);
    }

    hydrated = true;
    return memory;
  })();

  return hydratePromise;
}

export function saveDashboardCache(patch: Partial<DashboardCache>): void {
  memory = { ...memory, ...patch };
  dirty = true;

  // Nothing durable to merge into until the disk read has landed.
  if (!hydrated) return;

  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(memory)).catch(() => {});
}

export async function clearDashboardCache(): Promise<void> {
  memory = { counts: null, user: null, unread: false };
  dirty = true;

  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best effort - a stale cache is still guarded by sign-out, not by this.
  }
}