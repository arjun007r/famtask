/**
 * What a sent message is currently showing.
 *
 * A button tap arrives with a message id and nothing else, so without this
 * the engine cannot redraw the message the tap came from -- and a tap that
 * leaves the screen unchanged reads as a tap that did nothing. Views are
 * recorded when a message is sent and replayed on every tap, which also
 * means a redraw always reflects live rows rather than the text frozen at
 * send time.
 *
 * Overlays (menu, confirm, assign, detail) carry the view they cover, so
 * Back and Cancel restore exactly what was there.
 */
import type { Db } from '../db/adapter.ts';
import { getState, setState } from './state.ts';

export type View =
  /** A list of tasks: the digest, the group board, any /command listing. */
  | { k: 'board'; preamble: string; footer?: string; ids: string[]; claimIds: string[] }
  | { k: 'lists' }
  | { k: 'detail'; id: string; back?: View }
  | { k: 'menu'; id: string; back?: View }
  | { k: 'confirm'; id: string; back?: View }
  | { k: 'assign'; id: string; back?: View };

/** The views that stack on top of another view rather than replacing it. */
export type Overlay = Extract<View, { id: string }>;

const KEY_PREFIX = 'view:';
const key = (chatId: string, messageId: string) => `${KEY_PREFIX}${chatId}:${messageId}`;

export async function rememberView(
  db: Db,
  chatId: string,
  messageId: string,
  view: View,
): Promise<void> {
  await setState(db, key(chatId, messageId), JSON.stringify(view));
}

export async function recallView(db: Db, chatId: string, messageId: string): Promise<View | null> {
  const raw = await getState(db, key(chatId, messageId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as View;
  } catch {
    return null;
  }
}

/** The non-overlay view an overlay is stacked on. */
export function rootOf(view: View): View {
  let cur = view;
  while ('back' in cur && cur.back) cur = cur.back;
  return cur;
}

/** Nest an overlay, collapsing a repeat of the same overlay rather than
 *  growing the stack when someone taps the same button twice. */
export function overlay(current: View | null, next: Overlay): View {
  if (!current) return next;
  if (current.k === next.k) return { ...next, back: current.back };
  return { ...next, back: current };
}

/** Views outlive their usefulness the moment the message scrolls away.
 *  Swept on the scheduled run so app_state does not grow without bound. */
export async function pruneViews(db: Db, olderThan: string): Promise<void> {
  await db.run('DELETE FROM app_state WHERE key LIKE ? AND updated_at < ?', [
    `${KEY_PREFIX}%`,
    olderThan,
  ]);
}
