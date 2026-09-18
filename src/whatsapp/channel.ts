import { encodeAction } from '../channel/actions.ts';
import type {
  Button,
  FallbackTemplate,
  MessagingChannel,
  OutboundMessage,
} from '../channel/types.ts';
import { isOutsideWindow, splitForWhatsApp, type WhatsAppApi } from './api.ts';

/** Cloud API caps, all of them hard rejections rather than truncations. */
const MAX_REPLY_BUTTONS = 3;
const MAX_LIST_ROWS = 10;
const BUTTON_TITLE = 20;
const ROW_TITLE = 24;
const INTERACTIVE_BODY = 1024;

/**
 * Adapts the WhatsApp Cloud API to the channel interface the engine speaks.
 *
 * Three things differ from Telegram and are handled here rather than leaking
 * upward:
 *
 * - **No editing.** There is no edit endpoint, so `update` is deliberately not
 *   implemented and the engine's existing fallback posts a fresh message. That
 *   keeps the recorded view attached to the message the buttons are actually on.
 * - **No toasts.** `toasts: false` tells the engine to fold what would have
 *   been an ephemeral confirmation into the redraw, so nothing is dropped.
 * - **Far fewer buttons.** Three reply buttons, or ten list rows, against
 *   Telegram's effectively unlimited keyboard. See `collapse()`.
 */
export function whatsAppChannel(api: WhatsAppApi): MessagingChannel {
  return {
    name: 'whatsapp',
    toasts: false,

    async send(message: OutboundMessage) {
      try {
        return await deliver(api, message);
      } catch (err) {
        // Not an error so much as a rule: outside 24 hours only a template
        // gets through. A task list cannot be one -- template parameters
        // reject newlines -- so this is a nudge that reopens the window.
        if (isOutsideWindow(err) && message.fallback) {
          return sendTemplate(api, message.chatId, message.fallback);
        }
        throw err;
      }
    },

    async acknowledge(ackToken: string) {
      // The closest thing to acknowledging a tap. Whatever the engine wanted
      // to say arrives in the redraw instead, because toasts is false.
      await api
        .send({ status: 'read', message_id: ackToken })
        .catch((err) => console.error('whatsapp read receipt failed', err));
    },
  };
}

async function deliver(api: WhatsAppApi, message: OutboundMessage): Promise<string | null> {
  const buttons = collapse(message.buttons ?? []);
  const chunks = splitForWhatsApp(message.text).filter((c) => c.trim().length > 0);

  // Everything but the tail goes out as plain text; the tail carries the
  // buttons, unless it is too long to be an interactive body.
  const tail = chunks.pop() ?? '';
  for (const chunk of chunks) await text(api, message.chatId, chunk);

  if (buttons.length === 0) {
    return tail ? text(api, message.chatId, tail) : null;
  }
  if (tail.length > INTERACTIVE_BODY) {
    // Too long to be an interactive body, so it goes ahead of one. Losing the
    // buttons would be worse than an extra message.
    await text(api, message.chatId, tail);
    return interactiveMessage(api, message.chatId, 'Pick one:', buttons);
  }
  return interactiveMessage(api, message.chatId, tail || 'Pick one:', buttons);
}

async function text(api: WhatsAppApi, to: string, body: string): Promise<string | null> {
  const res = await api.send<SendResult>({
    to,
    type: 'text',
    text: { body, preview_url: false },
  });
  return messageId(res);
}

async function interactiveMessage(
  api: WhatsAppApi,
  to: string,
  body: string,
  buttons: Button[],
): Promise<string | null> {
  const res = await api.send<SendResult>({
    to,
    type: 'interactive',
    interactive:
      buttons.length <= MAX_REPLY_BUTTONS
        ? {
            type: 'button',
            body: { text: body },
            action: {
              buttons: buttons.map((b) => ({
                type: 'reply',
                reply: { id: encodeAction(b.action), title: fit(b.label, BUTTON_TITLE) },
              })),
            },
          }
        : {
            type: 'list',
            body: { text: body },
            action: {
              button: 'Choose',
              sections: [
                {
                  title: 'Actions',
                  rows: buttons.slice(0, MAX_LIST_ROWS).map((b) => ({
                    id: encodeAction(b.action),
                    title: fit(b.label, ROW_TITLE),
                  })),
                },
              ],
            },
          },
  });
  return messageId(res);
}

async function sendTemplate(
  api: WhatsAppApi,
  to: string,
  fallback: FallbackTemplate,
): Promise<string | null> {
  const components: Record<string, unknown>[] = [];
  if (fallback.params?.length) {
    components.push({
      type: 'body',
      // Meta rejects newlines, tabs and runs of spaces inside a parameter, so
      // a caller's multi-line text is flattened rather than bounced.
      parameters: fallback.params.map((p) => ({ type: 'text', text: flatten(p) })),
    });
  }
  if (fallback.action) {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [{ type: 'payload', payload: encodeAction(fallback.action) }],
    });
  }
  const res = await api.send<SendResult>({
    to,
    type: 'template',
    template: {
      name: fallback.name,
      language: { code: fallback.language ?? 'en' },
      ...(components.length ? { components } : {}),
    },
  });
  return messageId(res);
}

/**
 * Flatten a keyboard into the few buttons WhatsApp allows, keeping every
 * button the renderer marked primary before any that it did not. Ten slots
 * against a digest's worth of actions means something is dropped; what gets
 * dropped should be a second way into a task, never the only way into one.
 *
 * Order within each group is preserved, so the numbers still ascend.
 */
export function collapse(rows: Button[][]): Button[] {
  const flat = rows.flat();
  return [...flat.filter((b) => b.primary), ...flat.filter((b) => !b.primary)];
}

function fit(label: string, max: number): string {
  const trimmed = label.trim();
  if (!trimmed) return '·';
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

interface SendResult {
  messages?: { id?: string }[];
}

function messageId(res: SendResult): string | null {
  return res.messages?.[0]?.id ?? null;
}
