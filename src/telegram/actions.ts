/** Wire encoding for inline-button actions. Telegram caps callback_data at
 *  64 bytes, so this stays terse: a two-letter tag plus one id. */
import type { Action } from '../channel/types.ts';

const TAGS = {
  task_done: 'td',
  task_start: 'ts',
  task_block: 'tb',
  task_claim: 'tc',
  task_show: 'tv',
  digest_list_toggle: 'dl',
} as const;

export function encodeAction(action: Action): string {
  switch (action.kind) {
    case 'noop':
      return 'np';
    case 'digest_list_toggle':
      return `${TAGS.digest_list_toggle}:${action.listId}`;
    default:
      return `${TAGS[action.kind]}:${action.taskId}`;
  }
}

export function decodeAction(data: string): Action {
  const [tag, id] = data.split(':', 2);
  if (!id) return { kind: 'noop' };
  switch (tag) {
    case TAGS.task_done:
      return { kind: 'task_done', taskId: id };
    case TAGS.task_start:
      return { kind: 'task_start', taskId: id };
    case TAGS.task_block:
      return { kind: 'task_block', taskId: id };
    case TAGS.task_claim:
      return { kind: 'task_claim', taskId: id };
    case TAGS.task_show:
      return { kind: 'task_show', taskId: id };
    case TAGS.digest_list_toggle:
      return { kind: 'digest_list_toggle', listId: id };
    default:
      return { kind: 'noop' };
  }
}
