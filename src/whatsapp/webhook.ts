import { decodeAction } from '../channel/actions.ts';
import type { InboundAction, InboundMessage } from '../channel/types.ts';

interface WaProfile {
  name?: string;
}
interface WaContact {
  wa_id?: string;
  profile?: WaProfile;
}
interface WaInteractive {
  type?: string;
  button_reply?: { id?: string; title?: string };
  list_reply?: { id?: string; title?: string };
}
interface WaMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  interactive?: WaInteractive;
  /** A quick-reply tap on a template message. */
  button?: { payload?: string; text?: string };
}
export interface WaPayload {
  object?: string;
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: {
        messaging_product?: string;
        contacts?: WaContact[];
        messages?: WaMessage[];
        /** Delivery and read receipts for messages we sent. Never inbound. */
        statuses?: unknown[];
      };
    }[];
  }[];
}

export interface ParsedUpdate {
  updateId: string;
  message?: InboundMessage;
  action?: InboundAction;
}

/**
 * Meta batches; famtask handles one message per request because that is what
 * the engine and the dedupe table are shaped for. Batches above one are rare
 * in practice (they happen under retry) and the rest are dropped rather than
 * silently half-processed -- Meta redelivers on a non-200, and the dedupe
 * table makes the replay safe.
 */
export function parseUpdate(payload: WaPayload): ParsedUpdate | null {
  const value = payload.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  // Status callbacks outnumber real messages and carry no instruction.
  if (!message?.id || !message.from) return null;

  const name = value?.contacts?.[0]?.profile?.name?.trim() || message.from;
  const base = {
    chatId: message.from,
    chatType: 'dm' as const,
    userId: message.from,
    userDisplayName: name,
    messageId: message.id,
  };

  // WhatsApp has no groups here, so every message is addressed to the bot.
  if (message.type === 'text' && message.text?.body) {
    return { updateId: message.id, message: { ...base, text: message.text.body, addressedToBot: true } };
  }

  const data = actionData(message);
  if (data) {
    return {
      updateId: message.id,
      action: { ...base, action: decodeAction(data), ackToken: message.id },
    };
  }

  // Images, audio, reactions: understood well enough not to crash on.
  return { updateId: message.id };
}

function actionData(message: WaMessage): string | null {
  const i = message.interactive;
  return (
    i?.button_reply?.id ?? i?.list_reply?.id ?? message.button?.payload ?? null
  );
}

/** Meta's one-time subscription handshake: echo the challenge or refuse. */
export function verifySubscription(url: URL, verifyToken: string): string | null {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode !== 'subscribe' || !challenge) return null;
  return token && verifyToken && timingSafeEqual(token, verifyToken) ? challenge : null;
}

/**
 * Meta signs every delivery with the app secret. Without this check the
 * webhook is an open endpoint that will create tasks for anyone who finds it.
 */
export async function verifySignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header?.startsWith('sha256=') || !appSecret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return timingSafeEqual(header.slice('sha256='.length).toLowerCase(), expected);
}

/** Constant time in the length-equal case, which is the one that matters. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
