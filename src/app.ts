/**
 * Composition root. Everything above the channel interface is wired here:
 * inbound message -> parsing agent -> engine -> rendered reply, plus the
 * scheduled digest run. The Worker and the CLI both drive this file, which
 * is why neither of them contains any logic of its own.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { AgentUnavailableError } from './agents/client.ts';
import { planDigest, applyPlan } from './agents/digest-writer.ts';
import { parseMessage } from './agents/parser.ts';
import {
  renderDigest,
  renderDigestListPicker,
  renderGroupBoard,
  renderTaskDetail,
  renderTaskList,
} from './channel/format.ts';
import type {
  InboundAction,
  InboundMessage,
  MessagingChannel,
  RenderedMessage,
} from './channel/types.ts';
import type { Db } from './core/db/adapter.ts';
import { UserError } from './core/errors.ts';
import {
  buildDigest,
  buildGroupBoard,
  localDate,
  membersDueNow,
  recordDigestSends,
} from './core/services/digest.ts';
import { applyParsed, type InboxContext, type Notification } from './core/services/inbox.ts';
import {
  allLists,
  createList,
  digestListsFor,
  listsVisibleTo,
  MAX_DIGEST_LISTS,
  resolveList,
  toggleDigestList,
} from './core/services/lists.ts';
import { answerQuery } from './core/services/queries.ts';
import {
  addMember,
  ensureFamily,
  getMember,
  getMemberByTelegramUserId,
  listMembers,
  rememberChatId,
  setGroupChat,
  updateMemberPrefs,
} from './core/services/registry.ts';
import { claimOnce } from './core/services/state.ts';
import { claim, createTask, getTaskView, getThread, queryTasks, setState } from './core/services/tasks.ts';
import type { FamilyMember } from './core/types.ts';

export interface AppDeps {
  db: Db;
  channel: MessagingChannel;
  /** Absent means no agent layer: commands still work, free text does not. */
  anthropic: Anthropic | null;
  model?: string;
  now?: () => Date;
}

const now = (deps: AppDeps) => deps.now?.() ?? new Date();

export async function handleInboundMessage(deps: AppDeps, inbound: InboundMessage): Promise<void> {
  const { db } = deps;
  const family = await ensureFamily(db);
  let member = await getMemberByTelegramUserId(db, inbound.userId);

  if (!member) {
    const existing = await listMembers(db, family.id);
    if (existing.length === 0 && inbound.chatType === 'dm') {
      // Bootstrap: whoever sets the bot up is the first family member.
      member = await addMember(db, {
        familyId: family.id,
        name: inbound.userDisplayName,
        telegramUserId: inbound.userId,
        telegramChatId: inbound.chatId,
      });
      await resolveList(db, family.id, null);
      await reply(deps, inbound, {
        text: [
          `Hi ${member.name} — you're set up as the first member of this family.`,
          '',
          `Add someone else with:  /adduser <their telegram id> <name>`,
          'They can get their id by messaging me.',
          '',
          'Then just talk to me normally. /help lists the commands.',
        ].join('\n'),
      });
      return;
    }
    if (inbound.chatType === 'dm') {
      await reply(deps, inbound, {
        text: [
          `You're not in this family yet.`,
          `Your Telegram id is ${inbound.userId} — ask someone already in it to run:`,
          `/adduser ${inbound.userId} ${inbound.userDisplayName}`,
        ].join('\n'),
      });
    }
    return;
  }

  if (inbound.chatType === 'dm' && member.telegram_chat_id !== inbound.chatId) {
    await rememberChatId(db, member.id, inbound.chatId);
    member = { ...member, telegram_chat_id: inbound.chatId };
  }

  if (inbound.text.startsWith('/')) {
    const response = await runCommand(deps, member, inbound);
    if (response) await reply(deps, inbound, response);
    return;
  }

  if (!deps.anthropic) return;
  if (inbound.chatType === 'group' && !inbound.addressedToBot && !looksActionable(inbound.text)) {
    return;
  }

  const [members, lists, open] = await Promise.all([
    listMembers(db, family.id),
    allLists(db, family.id),
    queryTasks(db, { familyId: family.id, limit: 40 }),
  ]);

  let parsed;
  try {
    parsed = await parseMessage(
      deps.anthropic,
      inbound.text,
      {
        speakerName: member.name,
        chatType: inbound.chatType,
        memberNames: members.map((m) => m.name),
        listNames: lists.map((l) => l.name),
        openTasks: open.map(
          (t) => `${t.title} [${t.list_name}] — ${t.assignee_name ?? t.assignee_kind}`,
        ),
        today: localDate(member.timezone, now(deps)),
      },
      deps.model,
    );
  } catch (err) {
    if (!(err instanceof AgentUnavailableError)) throw err;
    // Swallow deliberately: a retry cannot fix an expired key or an empty
    // account, and throwing here would leave Telegram redelivering forever.
    // Say so in a DM; stay quiet in the group rather than shouting billing
    // errors at the whole family.
    if (inbound.chatType === 'dm') {
      await reply(deps, inbound, {
        text: `I couldn't read that — ${err.message}. Nothing was saved. /add and the other commands still work.`,
      });
    }
    return;
  }
  if (!parsed) {
    // The model answered without calling the tool. Rare, but silence here is
    // indistinguishable from the bot being down.
    console.warn('parser returned no structured result', { text: inbound.text.slice(0, 80) });
    if (inbound.chatType === 'dm') {
      await reply(deps, inbound, {
        text: "I couldn't make sense of that. Try /add <what needs doing>, or /help.",
      });
    }
    return;
  }
  console.log('parsed', { intent: parsed.intent, confidence: parsed.confidence });

  const ctx: InboxContext = {
    familyId: family.id,
    speaker: member,
    chatType: inbound.chatType,
    chatId: inbound.chatId,
    messageId: inbound.messageId,
    rawText: inbound.text,
  };

  let result;
  try {
    result = await applyParsed(db, ctx, parsed);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    await reply(deps, inbound, { text: err.message });
    return;
  }

  if (result.reply) {
    await reply(deps, inbound, result.reply);
  } else if (inbound.chatType === 'dm') {
    // A DM to a task bot is almost always meant as a task, so saying nothing
    // reads as a failure. In the group, staying quiet is the whole point.
    await reply(deps, inbound, { text: noReplyReason(parsed) });
  }
  await deliver(deps, result.notify, inbound.chatId);
}

/** Explain a deliberate non-action, so it cannot be mistaken for a fault. */
function noReplyReason(parsed: { intent: string; confidence: number }): string {
  if (parsed.intent === 'chitchat') {
    return "I didn't read that as a task. Use /add <what needs doing> if you want it saved.";
  }
  return `I wasn't confident enough about that one (${parsed.confidence.toFixed(2)}). Try /add <what needs doing>, or rephrase it.`;
}

/** DM people who need to know but are not reading the chat this came from. */
async function deliver(
  deps: AppDeps,
  notifications: Notification[],
  originChatId: string,
): Promise<void> {
  for (const note of notifications) {
    const member = await getMember(deps.db, note.memberId).catch(() => null);
    // Skip anyone with no DM open yet, and anyone already looking at this chat.
    if (!member?.telegram_chat_id || member.telegram_chat_id === originChatId) continue;
    await deps.channel.send({ chatId: member.telegram_chat_id, ...note.message });
  }
}

export async function handleInboundAction(deps: AppDeps, inbound: InboundAction): Promise<void> {
  const { db, channel } = deps;
  const member = await getMemberByTelegramUserId(db, inbound.userId);
  if (!member) {
    await channel.acknowledge(inbound.ackToken, "You're not in this family yet.");
    return;
  }

  const act = inbound.action;
  try {
    switch (act.kind) {
      case 'task_done': {
        await setState(db, act.taskId, 'done', member.id);
        const task = await getTaskView(db, act.taskId);
        await channel.acknowledge(inbound.ackToken, `Done: ${task.title}`);
        return;
      }
      case 'task_start': {
        await setState(db, act.taskId, 'in_progress', member.id);
        const task = await getTaskView(db, act.taskId);
        await channel.acknowledge(inbound.ackToken, `Started: ${task.title}`);
        return;
      }
      case 'task_block': {
        await setState(db, act.taskId, 'blocked', member.id);
        const task = await getTaskView(db, act.taskId);
        await channel.acknowledge(inbound.ackToken, `Blocked: ${task.title}`);
        return;
      }
      case 'task_claim': {
        await claim(db, act.taskId, member.id);
        const task = await getTaskView(db, act.taskId);
        await channel.acknowledge(inbound.ackToken, `Yours: ${task.title}`);
        await channel.send({ chatId: inbound.chatId, text: `${member.name} claimed "${task.title}".` });
        return;
      }
      case 'task_show': {
        await channel.acknowledge(inbound.ackToken);
        await channel.send({ chatId: inbound.chatId, ...(await taskDetail(db, act.taskId, member)) });
        return;
      }
      case 'digest_list_toggle': {
        const { atCap } = await toggleDigestList(db, member, act.listId);
        await channel.acknowledge(
          inbound.ackToken,
          atCap ? `Already at ${MAX_DIGEST_LISTS} — untick one first.` : undefined,
        );
        if (!atCap && channel.update) {
          await channel.update(inbound.chatId, inbound.messageId, await digestListPicker(db, member));
        }
        return;
      }
      default:
        await channel.acknowledge(inbound.ackToken);
    }
  } catch (err) {
    if (err instanceof UserError) {
      await channel.acknowledge(inbound.ackToken, err.message);
      return;
    }
    throw err;
  }
}

export async function handleGroupMembership(
  deps: AppDeps,
  event: { chatId: string; joined: boolean },
): Promise<void> {
  const family = await ensureFamily(deps.db);
  await setGroupChat(deps.db, family.id, event.joined ? event.chatId : null);
  if (event.joined) {
    await deps.channel.send({
      chatId: event.chatId,
      text: "I'll keep the family's shared tasks here. Unclaimed ones get posted each morning — tap to claim.",
    });
  }
}

/** Scheduled sweep. Fires hourly; only members whose local clock has reached
 *  their digest hour actually get a message. */
export async function runScheduledDigests(deps: AppDeps): Promise<number> {
  const { db, channel } = deps;
  const at = now(deps);
  const family = await ensureFamily(db);
  const members = await listMembers(db, family.id);
  const due = membersDueNow(members, at);

  let sent = 0;
  for (const member of due) {
    const today = localDate(member.timezone, at);
    const digest = await buildDigest(db, member, { now: at });
    if (digest.isEmpty) continue;

    let items = digest.items;
    let intro: string | null = null;
    if (deps.anthropic && items.length > 0) {
      // The deterministic ranking already stands on its own, so an agent
      // outage costs the intro line and nothing else. The digest still goes.
      const plan = await planDigest(deps.anthropic, member.name, items, {
        today,
        model: deps.model,
      }).catch((err) => {
        console.error('digest agent unavailable, sending ranked order', err);
        return null;
      });
      if (plan) {
        items = applyPlan(items, plan);
        intro = plan.intro || null;
      }
    }

    const rendered = renderDigest({ ...digest, items });
    await channel.send({
      chatId: member.telegram_chat_id!,
      ...rendered,
      text: intro ? `${intro}\n\n${stripFirstLine(rendered.text)}` : rendered.text,
    });
    await recordDigestSends(
      db,
      member.id,
      [...items, ...digest.unclaimed].map((t) => t.id),
      today,
    );
    sent += 1;
  }

  if (sent > 0 && family.group_chat_id) {
    const stamp = localDate(due[0]?.timezone ?? 'UTC', at);
    if (await claimOnce(db, `group_board:${family.id}`, stamp)) {
      const board = await buildGroupBoard(db, family.id, { now: at });
      if (board.length > 0) {
        await channel.send({ chatId: family.group_chat_id, ...renderGroupBoard(board) });
      }
    }
  }
  return sent;
}

// --- commands ---------------------------------------------------------------

const HELP = [
  'What I understand:',
  '  /tasks            your open tasks',
  '  /next             the single next thing',
  '  /open             unclaimed family tasks',
  '  /lists            all lists',
  '  /list <name>      one list',
  '  /newlist <name>   create a list',
  '  /digestlists      choose which lists feed your daily digest',
  '  /add <text>       add a task without the agent guessing',
  '  /settime <0-23>   digest hour, in your timezone',
  '  /settz <zone>     e.g. /settz Europe/London',
  '  /members          who is in the family',
  '  /adduser <id> <name>   add a family member',
  '  /here             use this group as the family group',
  '  /me               your settings',
  '',
  'Or just talk to me — I read normal messages too.',
].join('\n');

async function runCommand(
  deps: AppDeps,
  member: FamilyMember,
  inbound: InboundMessage,
): Promise<RenderedMessage | null> {
  const { db } = deps;
  const [head, ...rest] = inbound.text.trim().split(/\s+/);
  const arg = rest.join(' ').trim();
  const cmd = (head ?? '').toLowerCase().replace(/@.*$/, '');

  return guard(async () => {
    switch (cmd) {
      case '/start':
      case '/help':
        return { text: HELP };

      case '/tasks':
        return answerQuery(db, member, { scope: 'mine' });
      case '/next':
        return answerQuery(db, member, { scope: 'next' });
      case '/open':
        return answerQuery(db, member, { scope: 'unclaimed' });
      case '/lists':
        return answerQuery(db, member, { scope: 'list' });
      case '/list':
        return answerQuery(db, member, { scope: 'list', list: arg });

      case '/newlist': {
        if (!arg) return { text: 'Usage: /newlist <name>' };
        const list = await createList(db, { familyId: member.family_id, name: arg });
        return { text: `Created list "${list.name}".` };
      }

      case '/digestlists':
        return digestListPicker(db, member);

      case '/add': {
        if (!arg) return { text: 'Usage: /add <what needs doing>' };
        const list = await resolveList(db, member.family_id, null);
        const task = await createTask(db, {
          familyId: member.family_id,
          listId: list.id,
          title: arg,
          createdBy: member.id,
          assigneeKind: 'member',
          assignedTo: member.id,
          sourceChatId: inbound.chatId,
          sourceMessageId: inbound.messageId,
        });
        return renderTaskList('Added:', [await getTaskView(db, task.id)]);
      }

      case '/settime': {
        const hour = Number.parseInt(arg, 10);
        await updateMemberPrefs(db, member.id, { digestHour: hour });
        return { text: `Digest set to ${hour}:00 ${member.timezone}.` };
      }

      case '/settz': {
        if (!arg) return { text: 'Usage: /settz Europe/London' };
        try {
          new Intl.DateTimeFormat('en-CA', { timeZone: arg });
        } catch {
          return { text: `"${arg}" isn't a timezone I know.` };
        }
        await updateMemberPrefs(db, member.id, { timezone: arg });
        return { text: `Timezone set to ${arg}.` };
      }

      case '/members': {
        const members = await listMembers(db, member.family_id);
        return {
          text: ['Family:', ...members.map((m) => `• ${m.name} (${m.telegram_user_id})`)].join('\n'),
        };
      }

      case '/adduser': {
        const [id, ...nameParts] = rest;
        const name = nameParts.join(' ').trim();
        if (!id || !name) return { text: 'Usage: /adduser <telegram id> <name>' };
        const added = await addMember(db, {
          familyId: member.family_id,
          name,
          telegramUserId: id,
          timezone: member.timezone,
        });
        return { text: `Added ${added.name}. They should message me so I can DM them.` };
      }

      case '/here': {
        if (inbound.chatType !== 'group') return { text: 'Run /here inside the family group.' };
        await setGroupChat(db, member.family_id, inbound.chatId);
        return { text: "Got it — this is the family group." };
      }

      case '/me': {
        const { lists, needsChoice } = await digestListsFor(db, member);
        return {
          text: [
            `${member.name}`,
            `Digest: ${String(member.digest_hour).padStart(2, '0')}:00 ${member.timezone}`,
            `Digest lists: ${lists.map((l) => l.name).join(', ') || 'none'}`,
            needsChoice ? '(auto-picked — run /digestlists to choose)' : '',
          ]
            .filter(Boolean)
            .join('\n'),
        };
      }

      default:
        return { text: `I don't know ${cmd}.\n\n${HELP}` };
    }
  });
}

/** Full task card: description, assignee, and the clarification thread. */
async function taskDetail(db: Db, taskId: string, viewer: FamilyMember): Promise<RenderedMessage> {
  const task = await getTaskView(db, taskId);
  const thread = await getThread(db, taskId);
  const members = await listMembers(db, viewer.family_id);
  return renderTaskDetail(task, thread, new Map(members.map((m) => [m.id, m.name])));
}

async function digestListPicker(db: Db, member: FamilyMember): Promise<RenderedMessage> {
  const visible = await listsVisibleTo(db, member);
  const { lists } = await digestListsFor(db, member);
  return renderDigestListPicker(visible, new Set(lists.map((l) => l.id)), MAX_DIGEST_LISTS);
}

/** Turn expected failures into a reply instead of a 500. */
async function guard(fn: () => Promise<RenderedMessage | null>): Promise<RenderedMessage | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UserError) return { text: err.message };
    throw err;
  }
}

async function reply(
  deps: AppDeps,
  inbound: InboundMessage,
  message: RenderedMessage,
): Promise<void> {
  await deps.channel.send({
    chatId: inbound.chatId,
    ...message,
    ...(inbound.chatType === 'group' ? { replyToMessageId: inbound.messageId } : {}),
  });
}

/** Cheap prefilter so idle group chatter does not each cost an API call. */
export function looksActionable(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  if (/^(ok|okay|yes|no|haha|lol|thanks|ty|👍|❤️)\b/i.test(t)) return false;
  return /\b(need|needs|can you|could you|please|remember|don't forget|dont forget|book|call|pay|buy|pick up|schedule|email|send|fix|order|renew|cancel|due|deadline|by (mon|tue|wed|thu|fri|sat|sun|tomorrow|today)|todo|to-do|task|done|finished|started|stuck|blocked|waiting)\b/i.test(
    t,
  );
}

function stripFirstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(idx + 1).replace(/^\n/, '');
}
