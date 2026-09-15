import Anthropic from '@anthropic-ai/sdk';
import {
  handleGroupMembership,
  handleInboundAction,
  handleInboundMessage,
  mirrorTasks,
  runScheduledDigests,
  type AppDeps,
} from './app.ts';
import { d1Adapter } from './core/db/adapter.ts';
import { nowIso } from './core/ids.ts';
import { createTelegramApi } from './telegram/api.ts';
import { todoistTarget } from './sync/todoist.ts';
import { telegramChannel } from './telegram/channel.ts';
import type { MessagingChannel } from './channel/types.ts';
import { parseUpdate, type TgUpdate } from './telegram/webhook.ts';

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  TELEGRAM_BOT_USERNAME?: string;
  /** Optional: mirror tasks into Todoist. Absent means the mirror is off. */
  TODOIST_TOKEN?: string;
}

/**
 * Every channel this deployment can reach somebody on. A member is routed by
 * `family_members.channel`, so adding an app here is all it takes to let one
 * person use it -- nothing above the channel boundary changes.
 */
function buildChannels(env: Env): Record<string, MessagingChannel> {
  const channels: Record<string, MessagingChannel> = {};
  const telegram = telegramChannel(createTelegramApi(env.TELEGRAM_BOT_TOKEN));
  channels[telegram.name] = telegram;
  return channels;
}

/** `inbound` names the channel this request arrived on; replies default to
 *  it, while a digest fans out across all of them. */
function buildDeps(env: Env, inbound = 'telegram'): AppDeps {
  const channels = buildChannels(env);
  const channel = channels[inbound];
  if (!channel) throw new Error(`no adapter configured for channel "${inbound}"`);
  return {
    db: d1Adapter(env.DB),
    channel,
    channels,
    anthropic: env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null,
    sync: env.TODOIST_TOKEN ? todoistTarget(env.TODOIST_TOKEN) : null,
    model: env.CLAUDE_MODEL,
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok');
    }

    if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') {
      return new Response('not found', { status: 404 });
    }

    // Telegram echoes the secret set via setWebhook; anything else is noise
    // from the open internet.
    if (request.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    const update = (await request.json()) as TgUpdate;
    const deps = buildDeps(env);
    const parsed = parseUpdate(update, env.TELEGRAM_BOT_USERNAME);

    // Telegram redelivers on any non-200; make replays no-ops.
    const seen = await deps.db.first<{ update_id: string }>(
      'SELECT update_id FROM processed_updates WHERE update_id = ?',
      [parsed.updateId],
    );
    if (seen) return new Response('ok');
    await deps.db.run('INSERT OR IGNORE INTO processed_updates (update_id, created_at) VALUES (?, ?)', [
      parsed.updateId,
      nowIso(),
    ]);

    try {
      if (parsed.message) await handleInboundMessage(deps, parsed.message);
      else if (parsed.action) await handleInboundAction(deps, parsed.action);
      else if (parsed.groupMembership) await handleGroupMembership(deps, parsed.groupMembership);
      // After the reply, never before it: the mirror must not add latency
      // to what the person is waiting for, or fail their message if Todoist
      // is down.
      ctx.waitUntil(mirrorTasks(deps).catch((err) => console.error('sync failed', err)));
    } catch (err) {
      // Drop the dedupe row so Telegram's retry gets a real second attempt.
      await deps.db.run('DELETE FROM processed_updates WHERE update_id = ?', [parsed.updateId]);
      console.error('update failed', parsed.updateId, err);
      return new Response('error', { status: 500 });
    }

    return new Response('ok');
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScheduledDigests(buildDeps(env)).catch((err) => console.error('digest run failed', err)),
    );
  },
};
