import type { MessagingChannel, OutboundMessage, RenderedMessage } from '../channel/types.ts';
import { encodeAction } from './actions.ts';
import { splitForTelegram, TelegramApiError, type TelegramApi } from './api.ts';

/** Adapts the Bot API to the channel interface the engine speaks. Messages
 *  are sent as plain text -- no parse_mode -- so nothing needs escaping. */
export function telegramChannel(api: TelegramApi): MessagingChannel {
  return {
    async send(message: OutboundMessage) {
      const chunks = splitForTelegram(message.text);
      let lastId: string | null = null;
      for (const [i, chunk] of chunks.entries()) {
        const isLast = i === chunks.length - 1;
        const sent = await api.call<{ message_id?: number }>('sendMessage', {
          chat_id: message.chatId,
          text: chunk,
          ...(isLast && message.buttons ? { reply_markup: keyboard(message) } : {}),
          ...(i === 0 && message.replyToMessageId
            ? { reply_parameters: { message_id: Number(message.replyToMessageId), allow_sending_without_reply: true } }
            : {}),
        });
        if (sent?.message_id !== undefined) lastId = String(sent.message_id);
      }
      return lastId;
    },

    async acknowledge(ackToken: string, text?: string) {
      await api.call('answerCallbackQuery', {
        callback_query_id: ackToken,
        ...(text ? { text } : {}),
      });
    },

    async update(chatId: string, messageId: string, message: RenderedMessage) {
      try {
        await api.call('editMessageText', {
          chat_id: chatId,
          message_id: Number(messageId),
          text: splitForTelegram(message.text)[0],
          reply_markup: keyboard(message),
        });
      } catch (err) {
        // Redrawing a screen that already says the right thing is a no-op,
        // not a failure -- and must not fall back to a duplicate message.
        if (err instanceof TelegramApiError && /not modified/i.test(err.description)) return;
        throw err;
      }
    },
  };
}

function keyboard(message: RenderedMessage) {
  return {
    inline_keyboard: (message.buttons ?? []).map((row) =>
      row.map((b) => ({ text: b.label, callback_data: encodeAction(b.action) })),
    ),
  };
}
