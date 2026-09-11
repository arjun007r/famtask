import type { Priority, Task } from './types.ts';

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
  let score = PRIORITY_WEIGHT[task.priority];

  if (task.due_at) {
    const days = daysBetween(now, new Date(task.due_at));
    if (days < 0) score += 120; // overdue
    else if (days === 0) score += 90;
    else if (days <= 2) score += 60;
    else if (days <= 7) score += 30;
  }

  // A task that has been sitting in todo for a week deserves a nudge.
  const ageDays = daysBetween(new Date(task.created_at), now);
  score += Math.min(ageDays, 14);

  // Blocked and needs_clarification are waiting on a human answer, so they
  // are worth surfacing ahead of work that is merely not started.
  if (task.state === 'needs_clarification') score += 25;
  else if (task.state === 'blocked') score += 15;
  else if (task.state === 'in_progress') score += 10;

  score -= Math.min(opts.timesShown ?? 0, 5) * 12;
  return score;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
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
