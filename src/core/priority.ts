import { isClosed } from './state-machine.ts';
import type { Priority, Task, TaskState } from './types.ts';

/** A task due within this many days counts as urgent. */
export const DUE_SOON_DAYS = 2;

/** Where a task sits relative to its due date. Derived, never stored: a
 *  stored flag needs a sweep to keep it true and goes stale between runs,
 *  and changing the due date has to silently reset it. */
export type Timing = 'overdue' | 'due-soon' | 'upcoming' | 'none';

export function timingOf(
  task: { due_at: string | null; state: TaskState },
  now: Date = new Date(),
): Timing {
  if (!task.due_at || isClosed(task.state)) return 'none';
  const due = new Date(task.due_at);
  if (Number.isNaN(due.getTime())) return 'none';
  const days = dayDiff(now, due);
  if (days < 0) return 'overdue';
  if (days <= DUE_SOON_DAYS) return 'due-soon';
  return 'upcoming';
}

/**
 * The priority a task actually has right now. A deadline inside two days
 * outranks whatever was set when it was written down, so nothing has to be
 * re-prioritised by hand as it approaches. Move the due date out and it
 * drops back to the stored value on its own.
 */
export function effectivePriority(
  task: { priority: Priority; due_at: string | null; state: TaskState },
  now: Date = new Date(),
): Priority {
  const timing = timingOf(task, now);
  return timing === 'overdue' || timing === 'due-soon' ? 'high' : task.priority;
}

const PRIORITY_WEIGHT: Record<Priority, number> = { high: 300, medium: 200, low: 100 };

/**
 * Ranking score for digests and "what's next". Higher sorts first.
 *
 * Explicit priority dominates; due date and staleness break ties. Tasks
 * already surfaced in past digests are penalised so the next digest shows
 * the next batch, but a high-priority task stays near the top no matter how
 * often it has been shown -- nothing silently drops off.
 */
export function rankScore(
  task: Pick<Task, 'priority' | 'due_at' | 'created_at' | 'state'>,
  opts: { now?: Date; timesShown?: number } = {},
): number {
  const now = opts.now ?? new Date();
  let score = PRIORITY_WEIGHT[effectivePriority(task, now)];

  if (task.due_at) {
    const days = dayDiff(now, new Date(task.due_at));
    if (days < 0) score += 120; // overdue
    else if (days === 0) score += 90;
    else if (days <= DUE_SOON_DAYS) score += 60;
    else if (days <= 7) score += 30;
  }

  // A task that has been sitting in todo for a week deserves a nudge.
  const ageDays = dayDiff(new Date(task.created_at), now);
  score += Math.min(ageDays, 14);

  // Blocked and needs_clarification are waiting on a human answer, so they
  // are worth surfacing ahead of work that is merely not started.
  if (task.state === 'needs_clarification') score += 25;
  else if (task.state === 'blocked') score += 15;
  else if (task.state === 'in_progress') score += 10;

  score -= Math.min(opts.timesShown ?? 0, 5) * 12;
  return score;
}

/** Whole calendar days between two instants, UTC. Subtracting timestamps
 *  would call a task due at midnight today "overdue" by mid-morning. */
function dayDiff(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}

/** Language-based priority hint, used as a fallback when the parsing agent
 *  does not set one. */
export function inferPriorityFromText(text: string): Priority | null {
  const t = text.toLowerCase();
  if (/\b(urgent|asap|right away|immediately|critical|emergency|today|high priority)\b/.test(t)) {
    return 'high';
  }
  // "important" is the phrasing people actually reach for; the lookbehind
  // keeps "not important" out.
  if (/(?<!\bnot )\bimportant\b/.test(t)) return 'high';
  if (/\b(whenever|no rush|someday|eventually|low priority|if you get a chance)\b/.test(t)) {
    return 'low';
  }
  return null;
}
