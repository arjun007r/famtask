import type { ChatType, InboundAction, InboundMessage } from '../channel/types.ts';
import { decodeAction } from '../channel/actions.ts';

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  reply_to_message?: { from?: TgUser };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
  my_chat_member?: {
    chat: TgChat;
    new_chat_member?: { status: string; user?: TgUser };
  };
}

export interface ParsedUpdate {
  updateId: string;
  message?: InboundMessage;
  action?: InboundAction;
  /** Set when the bot was just added to (or removed from) a group. */
  groupMembership?: { chatId: string; chatType: ChatType; joined: boolean };
}

export function parseUpdate(update: TgUpdate, botUsername?: string): ParsedUpdate {
  const updateId = String(update.update_id);

  if (update.callback_query) {
    const cq = update.callback_query;
    return {
      updateId,
      action: {
        chatId: String(cq.message?.chat.id ?? cq.from.id),
        chatType: chatTypeOf(cq.message?.chat.type ?? 'private'),
        userId: String(cq.from.id),
        userDisplayName: displayName(cq.from),
        action: decodeAction(cq.data ?? ''),
        messageId: String(cq.message?.message_id ?? ''),
        ackToken: cq.id,
      },
    };
  }

  if (update.my_chat_member) {
    const { chat, new_chat_member } = update.my_chat_member;
    if (chat.type === 'group' || chat.type === 'supergroup') {
      const status = new_chat_member?.status ?? '';
      return {
        updateId,
        groupMembership: {
          chatId: String(chat.id),
          chatType: 'group',
          joined: status === 'member' || status === 'administrator',
        },
      };
    }
    return { updateId };
  }

  const msg = update.message ?? update.edited_message;
  const text = msg?.text ?? msg?.caption;
  if (!msg || !text || !msg.from || msg.from.is_bot) return { updateId };

  const chatType = chatTypeOf(msg.chat.type);
  const mention = botUsername ? new RegExp(`@${botUsername}\\b`, 'i').test(text) : false;
  const replyToBot = Boolean(msg.reply_to_message?.from?.is_bot);

  return {
    updateId,
    message: {
      chatId: String(msg.chat.id),
      chatType,
      userId: String(msg.from.id),
      userDisplayName: displayName(msg.from),
      text: stripMention(text, botUsername),
      messageId: String(msg.message_id),
      addressedToBot: chatType === 'dm' || mention || replyToBot || text.startsWith('/'),
    },
  };
}

function chatTypeOf(type: string): ChatType {
  return type === 'private' ? 'dm' : 'group';
}

function displayName(user: TgUser): string {
  return (
    [user.first_name, user.last_name].filter(Boolean).join(' ') ||
    user.username ||
    `user${user.id}`
  );
}

/** "/tasks@FamTaskBot" and "@FamTaskBot what's next" both lose the handle. */
function stripMention(text: string, botUsername?: string): string {
  if (!botUsername) return text.trim();
  return text.replace(new RegExp(`@${botUsername}\\b`, 'gi'), '').trim();
}
