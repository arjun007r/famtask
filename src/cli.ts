/**
 * Local harness. Drives the exact same app.ts the Worker does, with a
 * console channel instead of Telegram, so the engine and both agents can be
 * exercised end to end before a bot token exists.
 *
 *   npm run cli -- seed
 *   npm run cli -- say 1001 "can you book the dentist tomorrow, urgent"
 *   npm run cli -- group 1002 "I'll take the recycling one"
 *   npm run cli -- tap 1001 td:tsk_xxx
 *   npm run cli -- digest --now 2026-09-10T09:00:00Z
 */
import Anthropic from '@anthropic-ai/sdk';
import { handleInboundAction, handleInboundMessage, runScheduledDigests, type AppDeps } from './app.ts';
import { AgentUnavailableError } from './agents/client.ts';
import type { MessagingChannel } from './channel/types.ts';
import { fileDb } from './core/db/sqlite.ts';
import { addMember, ensureFamily, getMemberByTelegramUserId, listMembers } from './core/services/registry.ts';
import { createList, resolveList } from './core/services/lists.ts';
import { queryTasks } from './core/services/tasks.ts';
import { encodeAction } from './telegram/actions.ts';
import { decodeAction } from './telegram/actions.ts';

const DB_PATH = process.env.FAMTASK_DB ?? 'famtask.local.sqlite';

const consoleChannel: MessagingChannel = {
  async send(message) {
    console.log(`\n--- to ${message.chatId} ---\n${message.text}`);
    for (const row of message.buttons ?? []) {
      console.log(`   [ ${row.map((b) => `${b.label} -> ${encodeAction(b.action)}`).join(' | ')} ]`);
    }
  },
  async acknowledge(_token, text) {
    if (text) console.log(`(toast) ${text}`);
  },
  async update(chatId, messageId, message) {
    console.log(`\n--- edit ${chatId}/${messageId} ---\n${message.text}`);
  },
};

function deps(now?: Date): AppDeps {
  const { db } = fileDb(DB_PATH);
  return {
    db,
    channel: consoleChannel,
    anthropic: process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null,
    model: process.env.CLAUDE_MODEL,
    now: now ? () => now : undefined,
  };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'seed': {
      const d = deps();
      const family = await ensureFamily(d.db, 'Home');
      const existing = await listMembers(d.db, family.id);
      if (existing.length === 0) {
        await addMember(d.db, {
          familyId: family.id,
          name: 'Arjun',
          telegramUserId: '1001',
          telegramChatId: '1001',
          timezone: 'UTC',
        });
        await addMember(d.db, {
          familyId: family.id,
          name: 'Priya',
          telegramUserId: '1002',
          telegramChatId: '1002',
          timezone: 'UTC',
        });
        await resolveList(d.db, family.id, null);
        await createList(d.db, { familyId: family.id, name: 'Business' });
      }
      console.log('Seeded. Members:', (await listMembers(d.db, family.id)).map((m) => `${m.name}=${m.telegram_user_id}`).join(', '));
      return;
    }

    case 'say':
    case 'group': {
      const [userId, ...textParts] = args;
      if (!userId || textParts.length === 0) throw new Error(`usage: ${command} <telegramUserId> <text>`);
      const d = deps();
      const member = await getMemberByTelegramUserId(d.db, userId);
      await handleInboundMessage(d, {
        chatId: command === 'group' ? '-500' : userId,
        chatType: command === 'group' ? 'group' : 'dm',
        userId,
        userDisplayName: member?.name ?? `user${userId}`,
        text: textParts.join(' '),
        messageId: String(Date.now()),
        addressedToBot: command !== 'group',
      });
      return;
    }

    case 'tap': {
      const [userId, data] = args;
      if (!userId || !data) throw new Error('usage: tap <telegramUserId> <callback data>');
      const d = deps();
      const member = await getMemberByTelegramUserId(d.db, userId);
      await handleInboundAction(d, {
        chatId: userId,
        chatType: 'dm',
        userId,
        userDisplayName: member?.name ?? `user${userId}`,
        action: decodeAction(data),
        messageId: '1',
        ackToken: 'cli',
      });
      return;
    }

    case 'digest': {
      const nowFlag = args.indexOf('--now');
      const at = nowFlag >= 0 && args[nowFlag + 1] ? new Date(args[nowFlag + 1]!) : new Date();
      const d = deps(at);
      const sent = await runScheduledDigests(d);
      console.log(`\n${sent} digest(s) sent for ${at.toISOString()}`);
      return;
    }

    case 'tasks': {
      const d = deps();
      const family = await ensureFamily(d.db);
      const tasks = await queryTasks(d.db, { familyId: family.id, limit: 50 });
      for (const t of tasks) {
        console.log(`${t.id}  ${t.state.padEnd(20)} ${t.priority.padEnd(6)} ${t.title} [${t.list_name}] -> ${t.assignee_name ?? t.assignee_kind}`);
      }
      if (tasks.length === 0) console.log('(no open tasks)');
      return;
    }

    default:
      console.log(
        [
          'usage: npm run cli -- <command>',
          '  seed                       create a family with two members and two lists',
          '  say <userId> <text>        simulate a DM',
          '  group <userId> <text>      simulate a group message',
          '  tap <userId> <data>        simulate an inline-button tap',
          '  digest [--now ISO]         run the scheduled digest sweep',
          '  tasks                      list open tasks',
          '',
          'Set ANTHROPIC_API_KEY to enable the parsing and digest agents.',
        ].join('\n'),
      );
  }
}

main().catch((err) => {
  if (err instanceof AgentUnavailableError) {
    console.error(`Agent unavailable: ${err.message}.`);
    console.error('Slash commands still work without it — try: npm run cli -- say 1001 "/tasks"');
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
