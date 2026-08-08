import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { readSettings, writeSettings } from '../../store/settings';
import { runDueIntervalRoutines } from '../engine/routines';
import { sweep } from '../engine/checkSource';
import { clamp, errorMessage } from '../util';

/**
 * Background checking.
 *
 * The OS decides when this actually runs — `minimumInterval` is a floor, not a
 * promise, and Android may defer it for hours on a dozing device. The app is
 * built so that is fine: a foreground sweep covers anything the OS skipped, and
 * time-critical items are OS notifications rather than code that must run.
 */

export const CHECK_TASK = 'scout-background-check';

/** Cap per wake so a long watchlist cannot exhaust the execution window. */
const MAX_SOURCES_PER_WAKE = 6;

let defined = false;

/**
 * Must be called at module scope, before React renders — `defineTask` has to be
 * registered on every JS start, including the headless background start.
 */
export function defineBackgroundTask(): void {
  if (defined || Platform.OS === 'web') return;
  defined = true;

  TaskManager.defineTask(CHECK_TASK, async () => {
    try {
      const settings = await readSettings();
      if (!settings.backgroundEnabled) return BackgroundTask.BackgroundTaskResult.Success;

      // Stop burning battery and quota for someone who has stopped using the app.
      const lastSeen = settings.lastForegroundSweepAt ?? settings.lastBackgroundRunAt ?? 0;
      const idleDays = (Date.now() - lastSeen) / 86_400_000;
      if (lastSeen && idleDays > settings.backgroundPauseAfterDays) {
        return BackgroundTask.BackgroundTaskResult.Success;
      }

      const result = await sweep({
        trigger: 'background',
        limit: MAX_SOURCES_PER_WAKE,
      });
      await runDueIntervalRoutines({ limit: 2 });

      console.log(
        `[background] checked ${result.checked}, ${result.newEvents} new, ${result.errors.length} error(s)`,
      );
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch (e) {
      console.warn('[background] task failed', errorMessage(e));
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export type BackgroundAvailability = 'available' | 'restricted' | 'unsupported';

export async function availability(): Promise<BackgroundAvailability> {
  if (Platform.OS === 'web') return 'unsupported';
  try {
    const status = await BackgroundTask.getStatusAsync();
    return status === BackgroundTask.BackgroundTaskStatus.Available ? 'available' : 'restricted';
  } catch {
    return 'unsupported';
  }
}

export async function isRegistered(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    return await TaskManager.isTaskRegisteredAsync(CHECK_TASK);
  } catch {
    return false;
  }
}

/** Registers (or re-registers at a new interval) the periodic check. */
export async function register(intervalMin?: number): Promise<{ ok: boolean; reason?: string }> {
  if (Platform.OS === 'web') return { ok: false, reason: 'Background checks are not available on web.' };

  const settings = await readSettings();
  const minutes = clamp(intervalMin ?? settings.backgroundIntervalMin, 15, 1440);

  try {
    if (await isRegistered()) await BackgroundTask.unregisterTaskAsync(CHECK_TASK);
    await BackgroundTask.registerTaskAsync(CHECK_TASK, { minimumInterval: minutes });
    await writeSettings({ backgroundEnabled: true, backgroundIntervalMin: minutes });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errorMessage(e) };
  }
}

export async function unregister(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    if (await isRegistered()) await BackgroundTask.unregisterTaskAsync(CHECK_TASK);
  } catch (e) {
    console.warn('[background] could not unregister', errorMessage(e));
  }
  await writeSettings({ backgroundEnabled: false });
}

/** Keeps OS registration in step with the user's setting. Safe to call often. */
export async function reconcile(): Promise<void> {
  if (Platform.OS === 'web') return;
  const settings = await readSettings();
  const registered = await isRegistered();

  if (settings.backgroundEnabled && !registered) await register(settings.backgroundIntervalMin);
  else if (!settings.backgroundEnabled && registered) await unregister();
}

/** Development-only: makes the OS run the task right now. */
export async function triggerForTesting(): Promise<boolean> {
  if (Platform.OS === 'web' || !__DEV__) return false;
  try {
    return await BackgroundTask.triggerTaskWorkerForTestingAsync();
  } catch {
    return false;
  }
}
