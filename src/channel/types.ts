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
  /** Send me my digest now. The way back in on a channel that can only
   *  nudge unprompted, never say anything substantial. */
  | { kind: 'digest_show' }
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
  /**
   * The action someone actually came for, as opposed to a way into more
   * options. Channels with room show everything; channels with a hard cap
   * on buttons keep these and drop the rest.
   */
  primary?: boolean;
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

/**
 * What to send instead when a channel refuses the real message because the
 * person has not spoken recently. WhatsApp allows only pre-approved templates
 * outside a 24-hour window, and template parameters cannot contain newlines,
 * so a task list cannot be one -- this is a short nudge that gets them to
 * reply, which reopens the window.
 */
export interface FallbackTemplate {
  name: string;
  language?: string;
  /** Substituted into {{1}}, {{2}}… Newlines are rejected by the platform. */
  params?: string[];
  /** Payload for the template's quick-reply button, if it has one. */
  action?: Action;
}

export interface OutboundMessage extends RenderedMessage {
  /** Together with chatId this is the full address. Absent means the channel
   *  the current update arrived on, which is right for every reply. */
  channel?: string;
  chatId: string;
  replyToMessageId?: string;
  fallback?: FallbackTemplate;
}

export interface MessagingChannel {
  /** Matches `family_members.channel`. How the engine knows which adapter
   *  reaches which person when a family spans more than one app. */
  name: string;
  /**
   * False when the channel has no ephemeral acknowledgement for a button tap.
   * The engine then folds what would have been a toast into the redraw, so
   * nothing is silently dropped. Absent means it has one.
   */
  toasts?: boolean;
  /** Resolves to the channel-native id of the sent message, when the
   *  channel reports one. Needed to edit the message later. */
  send(message: OutboundMessage): Promise<string | null>;
  /** Acknowledge a button tap, optionally with a toast. */
  acknowledge(ackToken: string, text?: string): Promise<void>;
  /** Replace the text/buttons of a message already sent, when supported. */
  update?(chatId: string, messageId: string, message: RenderedMessage): Promise<void>;
}
