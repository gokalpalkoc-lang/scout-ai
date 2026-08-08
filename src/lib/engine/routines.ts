import { readSettings } from '../../store/settings';
import { queryEvents, upcomingDeadlines } from '../db/events';
import { listDueIntervalRoutines, listRoutines, updateRoutine } from '../db/routines';
import { listSources } from '../db/sources';
import { quickAsk } from '../gemini/agent';
import { resolveCredential } from '../gemini/auth';
import { generateContent } from '../gemini/client';
import { DIGEST_SCHEMA } from '../gemini/schemas';
import { textOf } from '../gemini/types';
import * as notify from '../notify';
import { Routine } from '../types';
import { errorMessage, truncate } from '../util';
import { formatEventDate, nowContextLine, relative } from '../util/date';
import { sweep } from './checkSource';

/**
 * Routines are the "routine tasks" half of the app.
 *
 * Two scheduling mechanisms, on purpose:
 *
 *  - daily/weekly routines get a real OS notification at the chosen time, so
 *    they fire reliably even if the app is never opened; tapping runs them.
 *  - interval routines run opportunistically, on a background wake or when the
 *    app comes to the foreground.
 *
 * Android will not let an app run arbitrary code at an exact wall-clock time, so
 * anything time-critical is expressed as a notification rather than pretended.
 */

export interface RoutineOutcome {
  routineId: string;
  name: string;
  ok: boolean;
  /** Text worth showing in the routine's history row. */
  result: string;
  notified: boolean;
}

/** Books or re-books the OS notification behind a daily/weekly routine. */
export async function syncRoutineSchedule(routine: Routine): Promise<string | null> {
  await notify.cancel(routine.notificationId);

  if (!routine.enabled || routine.scheduleKind === 'interval') {
    await updateRoutine(routine.id, { notificationId: null });
    return null;
  }

  const id = await notify.scheduleRoutine(
    routine.name,
    routine.id,
    routine.scheduleKind === 'daily'
      ? { kind: 'daily', hour: routine.hour, minute: routine.minute }
      : {
          kind: 'weekly',
          hour: routine.hour,
          minute: routine.minute,
          weekday: routine.weekday,
        },
  );
  await updateRoutine(routine.id, { notificationId: id });
  return id;
}

/** Re-books every routine — called at startup and after permission changes. */
export async function syncAllRoutineSchedules(): Promise<number> {
  const routines = await listRoutines();
  let booked = 0;
  for (const routine of routines) {
    const id = await syncRoutineSchedule(routine);
    if (id) booked += 1;
  }
  return booked;
}

export async function runRoutine(
  routine: Routine,
  opts: { silent?: boolean; signal?: AbortSignal } = {},
): Promise<RoutineOutcome> {
  const settings = await readSettings();
  const resolved = await resolveCredential(settings);

  const finish = async (ok: boolean, result: string, notified = false): Promise<RoutineOutcome> => {
    await updateRoutine(routine.id, {
      lastRunAt: Date.now(),
      lastResult: truncate(result, 800),
    });
    return { routineId: routine.id, name: routine.name, ok, result, notified };
  };

  if ('error' in resolved) return finish(false, resolved.error);
  const credential = resolved.credential;

  try {
    switch (routine.kind) {
      case 'check_all': {
        const result = await sweep({
          trigger: 'routine',
          all: true,
          silent: opts.silent,
          signal: opts.signal,
        });
        const summary =
          `Checked ${result.checked} site(s): ${result.newEvents} new event(s), ` +
          `${result.changedPages} page(s) changed` +
          (result.errors.length ? `, ${result.errors.length} error(s)` : '');

        // checkSource already notified per site; only speak up when nothing did.
        if (!opts.silent && result.newEvents === 0 && result.changedPages === 0) {
          await notify.notifyDigest(routine.name, 'Nothing new across your watched sites.');
          return finish(true, summary, true);
        }
        return finish(true, summary);
      }

      case 'digest': {
        const digest = await buildDigest(credential, settings.chatModel, routine.prompt);
        if (!opts.silent) await notify.notifyDigest(digest.headline, digest.body);
        return finish(true, digest.full, !opts.silent);
      }

      case 'prompt': {
        if (!routine.prompt?.trim()) return finish(false, 'This routine has no instruction to run.');

        const context = await buildContext();
        const answer = await quickAsk({
          credential,
          model: settings.chatModel,
          system:
            'You are Scout, running an unattended scheduled task on the user\'s phone. ' +
            'Answer in at most 6 short lines of plain text. No preamble, no markdown headings. ' +
            'The first line must work as a notification title of under 60 characters.',
          prompt: `${routine.prompt.trim()}\n\n---\nContext you may use:\n${context}`,
          maxOutputTokens: 2048,
          signal: opts.signal,
        });

        if (!answer) return finish(false, 'The model returned nothing.');
        const [first, ...rest] = answer.split('\n');
        if (!opts.silent) {
          await notify.notifyDigest(
            truncate(first || routine.name, 60),
            truncate(rest.join('\n').trim() || first, 240),
          );
        }
        return finish(true, answer, !opts.silent);
      }

      case 'reminder': {
        if (!opts.silent) {
          await notify.notifyDigest(routine.name, routine.prompt?.trim() || 'Reminder from Scout.');
        }
        return finish(true, 'Reminder delivered.', !opts.silent);
      }

      default:
        return finish(false, `Unknown routine kind "${routine.kind}".`);
    }
  } catch (e) {
    return finish(false, errorMessage(e));
  }
}

export interface Digest {
  headline: string;
  body: string;
  full: string;
}

/** Summarises the agenda into something worth reading on a lock screen. */
export async function buildDigest(
  credential: Parameters<typeof generateContent>[0]['credential'],
  model: string,
  extraInstruction?: string | null,
): Promise<Digest> {
  const [events, deadlines, sources] = await Promise.all([
    queryEvents({ limit: 80 }),
    upcomingDeadlines(21),
    listSources(),
  ]);

  const soon = events.slice(0, 40);
  const newOnes = soon.filter((e) => e.isNew);

  if (!soon.length && !deadlines.length) {
    return {
      headline: 'Nothing on the calendar',
      body:
        sources.length === 0
          ? 'Add a website to watch and Scout will start filling this in.'
          : 'No upcoming events found on your watched sites.',
      full: 'Nothing upcoming was found.',
    };
  }

  const lines = [
    `It is ${nowContextLine()}.`,
    extraInstruction?.trim() ? `The user asked: ${extraInstruction.trim()}` : '',
    '',
    'UPCOMING EVENTS:',
    ...soon.map(
      (e) =>
        `- ${formatEventDate(e.startsAt)} | ${e.title}` +
        `${e.location ? ` | ${e.location}` : ''}` +
        `${e.isNew ? ' | NEW' : ''}${e.starred ? ' | STARRED' : ''}`,
    ),
    '',
    'DEADLINES:',
    ...(deadlines.length
      ? deadlines.map(
          (e) => `- ${e.deadlineAt} | ${e.title}${e.deadlineLabel ? ` (${e.deadlineLabel})` : ''}`,
        )
      : ['- none in the next three weeks']),
  ].filter(Boolean);

  const res = await generateContent({
    credential,
    model,
    request: {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                'Write the user\'s briefing from the data below.',
                'Put anything urgent or newly found first. Mention deadlines closing within a week explicitly.',
                'Never invent an event that is not listed. If the list is thin, say so briefly.',
                newOnes.length
                  ? `${newOnes.length} of these events are newly found since the user last looked — lead with those.`
                  : 'Nothing is newly found, so lead with what is soonest.',
                '',
                lines.join('\n'),
              ].join('\n'),
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: DIGEST_SCHEMA,
        maxOutputTokens: 4096,
      },
    },
  });

  try {
    const parsed = JSON.parse(textOf(res)) as Partial<Digest>;
    return {
      headline: truncate(parsed.headline?.trim() || 'Your briefing', 60),
      body: truncate(parsed.body?.trim() || 'Tap to see what is coming up.', 240),
      full: parsed.full?.trim() || parsed.body?.trim() || 'No details returned.',
    };
  } catch {
    return {
      headline: 'Your briefing',
      body: `${soon.length} upcoming, ${deadlines.length} deadline(s).`,
      full: lines.join('\n'),
    };
  }
}

/** Compact app state handed to `prompt` routines so they can be specific. */
async function buildContext(): Promise<string> {
  const [events, sources, deadlines] = await Promise.all([
    queryEvents({ limit: 30 }),
    listSources(),
    upcomingDeadlines(21),
  ]);

  return [
    `Watched sites (${sources.length}): ${
      sources.map((s) => `${s.title} [last checked ${s.lastCheckedAt ? relative(s.lastCheckedAt) : 'never'}]`).join('; ') || 'none'
    }`,
    `Upcoming events (${events.length}):`,
    ...events
      .slice(0, 25)
      .map((e) => `- ${formatEventDate(e.startsAt)} | ${e.title}${e.location ? ` | ${e.location}` : ''}`),
    `Deadlines: ${
      deadlines.map((e) => `${e.title} by ${e.deadlineAt}`).join('; ') || 'none in three weeks'
    }`,
  ].join('\n');
}

/** Runs interval routines that are due. Called from background and foreground. */
export async function runDueIntervalRoutines(
  opts: { silent?: boolean; limit?: number } = {},
): Promise<RoutineOutcome[]> {
  const due = await listDueIntervalRoutines();
  const outcomes: RoutineOutcome[] = [];
  for (const routine of due.slice(0, opts.limit ?? 3)) {
    outcomes.push(await runRoutine(routine, { silent: opts.silent }));
  }
  return outcomes;
}
