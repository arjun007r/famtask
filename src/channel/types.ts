/**
 * The messaging-channel boundary. Everything above this line (core engine,
 * agents, formatting) knows nothing about Telegram; everything Telegram
 * lives in src/telegram and implements these types.
 */

import type { View } from '../core/services/views.ts';

export type ChatType = 'dm' | 'group';

export interface InboundMessage {
  /** Channel-native chat id. */
  chatId: string;
  chatType: ChatType;
  /** Channel-native user id of the sender. */
  userId: string;
  userDisplayName: string;
  text: string;
  messageId: string;
  /** True when the bot was addressed directly in a group. */
  addressedToBot: boolean;
}

/** One-tap actions carried by inline buttons. Structured, not stringly --
 *  the channel layer owns the wire encoding. */
export type Action =
  /** Asks; does not apply. Finishing a task is the one tap worth confirming. */
  | { kind: 'task_done'; taskId: string }
  | { kind: 'task_done_confirm'; taskId: string }
  | { kind: 'task_start'; taskId: string }
  | { kind: 'task_block'; taskId: string }
  | { kind: 'task_ask'; taskId: string }
  | { kind: 'task_claim'; taskId: string }
  | { kind: 'task_show'; taskId: string }
  | { kind: 'task_menu'; taskId: string }
  | { kind: 'task_reassign'; taskId: string }
  /** The outsider came back; setting a wait needs free text, so it stays a message. */
  | { kind: 'task_waiting_clear'; taskId: string }
  /** `to` is a member id, or 'group' for up-for-grabs. */
  | { kind: 'task_assign'; taskId: string; to: string }
  /** Dismiss an overlay and redraw whatever it covered. */
  | { kind: 'view_back' }
  | { kind: 'digest_list_toggle'; listId: string }
  | { kind: 'noop' };

export interface InboundAction {
  chatId: string;
  chatType: ChatType;
  userId: string;
  userDisplayName: string;
  action: Action;
  messageId: string;
  /** Opaque handle the channel needs to acknowledge the tap. */
  ackToken: string;
}

export interface Button {
  label: string;
  action: Action;
}

/** Plain text plus buttons. Deliberately no markup: every channel renders
 *  emphasis differently and escaping bugs are not worth the bold. */
export interface RenderedMessage {
  text: string;
  buttons?: Button[][];
  /**
   * What this message is showing, recorded when it is sent so a later tap
   * can redraw it in place. Channel-agnostic and never rendered.
   */
  view?: View;
}

export interface OutboundMessage extends RenderedMessage {
  chatId: string;
  replyToMessageId?: string;
}

export interface MessagingChannel {
  /** Resolves to the channel-native id of the sent message, when the
   *  channel reports one. Needed to edit the message later. */
  send(message: OutboundMessage): Promise<string | null>;
  /** Acknowledge a button tap, optionally with a toast. */
  acknowledge(ackToken: string, text?: string): Promise<void>;
  /** Replace the text/buttons of a message already sent, when supported. */
  update?(chatId: string, messageId: string, message: RenderedMessage): Promise<void>;
}
