/** Wire encoding for inline-button actions. Telegram caps callback_data at
 *  64 bytes, so this stays terse: a two-letter tag plus ids. Task and member
 *  ids are 20 characters, so even the two-id form fits with room to spare. */
import type { Action } from '../channel/types.ts';

const TAGS = {
  task_done: 'td',
  task_done_confirm: 'dy',
  task_start: 'ts',
  task_block: 'tb',
  task_ask: 'tq',
  task_claim: 'tc',
  task_show: 'tv',
  task_menu: 'tm',
  task_reassign: 'tr',
  task_waiting_clear: 'wc',
  task_assign: 'ta',
  digest_list_toggle: 'dl',
} as const;

export function encodeAction(action: Action): string {
  switch (action.kind) {
    case 'noop':
      return 'np';
    case 'view_back':
      return 'bk';
    case 'digest_list_toggle':
      return `${TAGS.digest_list_toggle}:${action.listId}`;
    case 'task_assign':
      return `${TAGS.task_assign}:${action.taskId}:${action.to}`;
    default:
      return `${TAGS[action.kind]}:${action.taskId}`;
  }
}

export function decodeAction(data: string): Action {
  const [tag, id, extra] = data.split(':', 3);
  if (tag === 'bk') return { kind: 'view_back' };
  if (!id) return { kind: 'noop' };
  switch (tag) {
    case TAGS.task_done:
      return { kind: 'task_done', taskId: id };
    case TAGS.task_done_confirm:
      return { kind: 'task_done_confirm', taskId: id };
    case TAGS.task_start:
      return { kind: 'task_start', taskId: id };
    case TAGS.task_block:
      return { kind: 'task_block', taskId: id };
    case TAGS.task_ask:
      return { kind: 'task_ask', taskId: id };
    case TAGS.task_claim:
      return { kind: 'task_claim', taskId: id };
    case TAGS.task_show:
      return { kind: 'task_show', taskId: id };
    case TAGS.task_menu:
      return { kind: 'task_menu', taskId: id };
    case TAGS.task_reassign:
      return { kind: 'task_reassign', taskId: id };
    case TAGS.task_waiting_clear:
      return { kind: 'task_waiting_clear', taskId: id };
    case TAGS.task_assign:
      return extra ? { kind: 'task_assign', taskId: id, to: extra } : { kind: 'noop' };
    case TAGS.digest_list_toggle:
      return { kind: 'digest_list_toggle', listId: id };
    default:
      return { kind: 'noop' };
  }
}
