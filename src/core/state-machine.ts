import { UserError } from './errors.ts';
import type { TaskState } from './types.ts';

/**
 * todo -> in_progress -> blocked | needs_clarification -> done
 *
 * blocked and needs_clarification are first-class because tasks bounce: a
 * task can move between them and in_progress any number of times. done and
 * cancelled are terminal but reopenable, so nothing is ever truly stuck.
 */
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  todo: ['in_progress', 'blocked', 'needs_clarification', 'done', 'cancelled'],
  in_progress: ['todo', 'blocked', 'needs_clarification', 'done', 'cancelled'],
  blocked: ['todo', 'in_progress', 'needs_clarification', 'done', 'cancelled'],
  needs_clarification: ['todo', 'in_progress', 'blocked', 'done', 'cancelled'],
  done: ['todo', 'in_progress'],
  cancelled: ['todo', 'in_progress'],
};

/** States that keep a task out of digests and "my tasks" listings. */
export const CLOSED_STATES: readonly TaskState[] = ['done', 'cancelled'];
export const OPEN_STATES: readonly TaskState[] = [
  'todo',
  'in_progress',
  'blocked',
  'needs_clarification',
];

export function isClosed(state: TaskState): boolean {
  return CLOSED_STATES.includes(state);
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return from === to || (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new UserError(`Can't move a task from ${from} to ${to}.`);
  }
}

const LABELS: Record<TaskState, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  needs_clarification: 'Needs clarification',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function stateLabel(state: TaskState): string {
  return LABELS[state];
}
