import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { memoryDb } from '../src/core/db/sqlite.ts';
import type { Db } from '../src/core/db/adapter.ts';
import { canTransition, isClosed } from '../src/core/state-machine.ts';
import {
  rankScore,
  inferPriorityFromText,
  effectivePriority,
  timingOf,
} from '../src/core/priority.ts';
import {
  addMember,
  ensureFamily,
  getMemberByChannelId,
  matchMemberByName,
  setGroupChat,
  updateMemberPrefs,
} from '../src/core/services/registry.ts';
import {
  createList,
  digestListsFor,
  MAX_DIGEST_LISTS,
  resolveList,
  setDigestLists,
  toggleDigestList,
} from '../src/core/services/lists.ts';
import {
  claim,
  createTask,
  getTaskView,
  queryTasks,
  rankTasks,
  setState,
  setWaitingOn,
} from '../src/core/services/tasks.ts';
import { buildDigest, localHour, membersDueNow, recordDigestSends } from '../src/core/services/digest.ts';
import { applyParsed, matchTask, type InboxContext } from '../src/core/services/inbox.ts';
import { answerQuery } from '../src/core/services/queries.ts';
import { reconcile, shapeHash } from '../src/core/services/sync.ts';
import { sanitize } from '../src/agents/digest-writer.ts';
import {
  taskLine,
  multipleLists,
  renderTaskList,
  renderTaskMenu,
} from '../src/channel/format.ts';
import { TOOL_SCHEMA } from '../src/agents/parser.ts';
import { decodeAction, encodeAction } from '../src/telegram/actions.ts';
import { parseUpdate } from '../src/telegram/webhook.ts';
import {
  handleInboundAction,
  handleInboundMessage,
  looksActionable,
  runScheduledDigests,
  type AppDeps,
} from '../src/app.ts';
import { describeAgentFailure, supportsEffort } from '../src/agents/client.ts';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  Action,
  MessagingChannel,
  OutboundMessage,
  RenderedMessage,
} from '../src/channel/types.ts';
import { rememberView } from '../src/core/services/views.ts';
import type { FamilyMember, TaskView } from '../src/core/types.ts';

async function setup() {
  const { db } = memoryDb();
  const family = await ensureFamily(db, 'Home');
  const arjun = await addMember(db, {
    familyId: family.id,
    name: 'Arjun',
    channelUserId: '1001',
    channelChatId: '1001',
  });
  const priya = await addMember(db, {
    familyId: family.id,
    name: 'Priya',
    channelUserId: '1002',
    channelChatId: '1002',
  });
  const home = await resolveList(db, family.id, null);
  return { db, familyId: family.id, arjun, priya, home };
}

function ctxFor(familyId: string, speaker: FamilyMember, chatType: 'dm' | 'group', text: string): InboxContext {
  return { familyId, speaker, chatType, chatId: 'c1', messageId: 'm1', rawText: text };
}

describe('state machine', () => {
  it('allows the bounce between blocked and in_progress', () => {
    assert.ok(canTransition('in_progress', 'blocked'));
    assert.ok(canTransition('blocked', 'needs_clarification'));
    assert.ok(canTransition('needs_clarification', 'in_progress'));
  });

  it('treats done and cancelled as closed but reopenable', () => {
    assert.ok(isClosed('done') && isClosed('cancelled'));
    assert.ok(canTransition('done', 'todo'));
    assert.ok(!canTransition('done', 'blocked'));
  });
});

describe('priority', () => {
  it('ranks overdue high above a distant high', () => {
    const now = new Date('2026-09-09T00:00:00Z');
    const overdue = rankScore(
      { priority: 'high', due_at: '2026-09-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z', state: 'todo' },
      { now },
    );
    const distant = rankScore(
      { priority: 'high', due_at: '2026-12-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z', state: 'todo' },
      { now },
    );
    assert.ok(overdue > distant);
  });

  it('demotes tasks already shown, without sinking them below a lower priority', () => {
    const base = { due_at: null, created_at: '2026-09-01T00:00:00Z', state: 'todo' } as const;
    const now = new Date('2026-09-09T00:00:00Z');
    const shownHigh = rankScore({ ...base, priority: 'high' }, { now, timesShown: 5 });
    const freshLow = rankScore({ ...base, priority: 'low' }, { now, timesShown: 0 });
    const freshHigh = rankScore({ ...base, priority: 'high' }, { now, timesShown: 0 });
    assert.ok(shownHigh < freshHigh, 'repeated tasks should sink within their tier');
    assert.ok(shownHigh > freshLow, 'but never below a lower-priority task');
  });

  it('reads urgency out of language', () => {
    assert.equal(inferPriorityFromText('need this ASAP'), 'high');
    assert.equal(inferPriorityFromText('whenever you get a chance'), 'low');
    assert.equal(inferPriorityFromText('please book it'), null);
  });

  it('treats "important" as urgent, but not "not important"', () => {
    assert.equal(inferPriorityFromText('cancel Hulu, very very important'), 'high');
    assert.equal(inferPriorityFromText('this is important'), 'high');
    assert.equal(inferPriorityFromText('it is not important'), null);
  });
});

describe('due dates drive urgency', () => {
  const NOW = new Date('2026-09-11T14:00:00Z');
  const task = (due: string | null, priority = 'low', state = 'todo') =>
    ({ due_at: due, priority, state }) as Parameters<typeof effectivePriority>[0];

  it('does not call a task due today overdue', () => {
    // Comparing timestamps rather than calendar days would flip this to
    // "overdue" by mid-morning on the day it is due.
    assert.equal(timingOf(task('2026-09-11T00:00:00Z'), NOW), 'due-soon');
  });

  it('escalates inside two days and reports overdue after', () => {
    assert.equal(timingOf(task('2026-09-13T00:00:00Z'), NOW), 'due-soon');
    assert.equal(timingOf(task('2026-09-20T00:00:00Z'), NOW), 'upcoming');
    assert.equal(timingOf(task('2026-09-09T00:00:00Z'), NOW), 'overdue');

    assert.equal(effectivePriority(task('2026-09-12T00:00:00Z'), NOW), 'high');
    assert.equal(effectivePriority(task('2026-09-09T00:00:00Z'), NOW), 'high');
    assert.equal(effectivePriority(task('2026-09-30T00:00:00Z'), NOW), 'low');
  });

  it('drops back when the date moves out — no second write', () => {
    assert.equal(effectivePriority(task('2026-09-09T00:00:00Z'), NOW), 'high');
    assert.equal(effectivePriority(task('2026-10-09T00:00:00Z'), NOW), 'low');
  });

  it('ignores the deadline once the task is closed', () => {
    assert.equal(timingOf(task('2026-09-01T00:00:00Z', 'low', 'done'), NOW), 'none');
    assert.equal(effectivePriority(task('2026-09-01T00:00:00Z', 'low', 'done'), NOW), 'low');
  });
});

describe('tasks', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });

  it('records a created event and enforces the assignee invariant', async () => {
    const task = await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'Book dentist',
      createdBy: env.arjun.id,
      assigneeKind: 'member',
      assignedTo: env.priya.id,
    });
    assert.equal(task.assignee_kind, 'member');
    const events = await env.db.all<{ kind: string }>('SELECT kind FROM task_events WHERE task_id = ?', [task.id]);
    assert.deepEqual(events.map((e) => e.kind), ['created']);
  });

  it('falls back to unassigned when a member id is missing', async () => {
    const task = await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'Someone take the bins out',
      assigneeKind: 'member',
    });
    assert.equal(task.assignee_kind, 'unassigned');
    assert.equal(task.assigned_to, null);
  });

  it('rejects an illegal transition and closes on done', async () => {
    const task = await createTask(env.db, { familyId: env.familyId, listId: env.home.id, title: 'x' });
    await setState(env.db, task.id, 'done', env.arjun.id);
    await assert.rejects(() => setState(env.db, task.id, 'blocked', env.arjun.id), /Can't move/);
    const fresh = await getTaskView(env.db, task.id);
    assert.ok(fresh.closed_at);
  });

  it('refuses a second claim on the same task', async () => {
    const task = await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'Fix the gate',
      assigneeKind: 'group',
    });
    await claim(env.db, task.id, env.arjun.id);
    await assert.rejects(() => claim(env.db, task.id, env.priya.id), /already claimed/);
  });

  it('excludes closed tasks from open queries', async () => {
    const task = await createTask(env.db, { familyId: env.familyId, listId: env.home.id, title: 'Pay water bill' });
    await setState(env.db, task.id, 'done', env.arjun.id);
    const open = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(open.length, 0);
  });
});

describe('lists and digest selection', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });

  it('includes every list automatically at or below the cap', async () => {
    await createList(env.db, { familyId: env.familyId, name: 'Business' });
    const { lists, needsChoice } = await digestListsFor(env.db, env.arjun);
    assert.equal(lists.length, 2);
    assert.equal(needsChoice, false);
  });

  it('asks for a choice past the cap, then honours the pick', async () => {
    for (const name of ['Business', 'House', 'Kids']) {
      await createList(env.db, { familyId: env.familyId, name });
    }
    const auto = await digestListsFor(env.db, env.arjun);
    assert.equal(auto.lists.length, MAX_DIGEST_LISTS);
    assert.equal(auto.needsChoice, true);

    const business = auto.lists.find((l) => l.name === 'Business') ?? auto.lists[0]!;
    await setDigestLists(env.db, env.arjun.id, [business.id]);
    const picked = await digestListsFor(env.db, env.arjun);
    assert.deepEqual(picked.lists.map((l) => l.name), [business.name]);
    assert.equal(picked.needsChoice, false);
  });

  it('will not toggle past the cap', async () => {
    const names = ['Business', 'House', 'Kids'];
    for (const name of names) await createList(env.db, { familyId: env.familyId, name });
    const all = await env.db.all<{ id: string }>('SELECT id FROM lists ORDER BY name');
    await setDigestLists(env.db, env.arjun.id, all.slice(0, 3).map((l) => l.id));
    const { atCap } = await toggleDigestList(env.db, env.arjun, all[3]!.id);
    assert.equal(atCap, true);
  });

  it('keeps personal lists out of another member\'s view', async () => {
    await createList(env.db, { familyId: env.familyId, name: 'Priya solo', ownerMemberId: env.priya.id });
    const { lists } = await digestListsFor(env.db, env.arjun);
    assert.ok(!lists.some((l) => l.name === 'Priya solo'));
  });

  it('creates an unknown list on the fly rather than dropping the task', async () => {
    const list = await resolveList(env.db, env.familyId, 'Garden');
    assert.equal(list.name, 'Garden');
    assert.equal((await resolveList(env.db, env.familyId, 'garden')).id, list.id);
  });
});

describe('digest', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });

  it('caps at five, appends unclaimed work, and never repeats a done task', async () => {
    for (let i = 0; i < 7; i += 1) {
      await createTask(env.db, {
        familyId: env.familyId,
        listId: env.home.id,
        title: `Task ${i}`,
        assigneeKind: 'member',
        assignedTo: env.arjun.id,
      });
    }
    const shared = await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'Book the car service',
      assigneeKind: 'group',
    });

    const first = await buildDigest(env.db, env.arjun);
    assert.equal(first.items.length, 5);
    assert.ok(first.unclaimed.some((t) => t.id === shared.id));

    await recordDigestSends(env.db, env.arjun.id, first.items.map((t) => t.id), '2026-09-09');
    await setState(env.db, first.items[0]!.id, 'done', env.arjun.id);

    const second = await buildDigest(env.db, env.arjun);
    const firstIds = new Set(first.items.map((t) => t.id));
    assert.ok(!second.items.some((t) => t.state === 'done'));
    assert.ok(
      second.items.some((t) => !firstIds.has(t.id)),
      'the next digest should surface a task the previous one did not',
    );
  });

  it('only fires for members whose local clock reached their hour', () => {
    const at = new Date('2026-09-09T09:00:00Z');
    const members = [
      { ...env.arjun, timezone: 'UTC', digest_hour: 9 },
      { ...env.priya, timezone: 'UTC', digest_hour: 18 },
    ];
    const due = membersDueNow(members, at);
    assert.deepEqual(due.map((m) => m.name), ['Arjun']);
  });

  it('respects per-person timezones off one hourly trigger', () => {
    const at = new Date('2026-09-09T09:00:00Z');
    assert.equal(localHour('UTC', at), 9);
    assert.equal(localHour('America/New_York', at), 5);
    const members = [
      { ...env.arjun, timezone: 'America/New_York', digest_hour: 5 },
      { ...env.priya, timezone: 'UTC', digest_hour: 5 },
    ];
    assert.deepEqual(membersDueNow(members, at).map((m) => m.name), ['Arjun']);
  });

  it('skips members with no DM chat yet', () => {
    const members = [{ ...env.arjun, channel_chat_id: null, timezone: 'UTC', digest_hour: 9 }];
    assert.equal(membersDueNow(members, new Date('2026-09-09T09:00:00Z')).length, 0);
  });
});

describe('inbox', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });

  it('ignores chit-chat and low-confidence reads', async () => {
    const ctx = ctxFor(env.familyId, env.arjun, 'group', 'haha same');
    assert.equal((await applyParsed(env.db, ctx, { intent: 'chitchat', confidence: 0.9 })).reply, null);
    const lowConfidence = await applyParsed(env.db, ctx, {
      intent: 'new_task',
      confidence: 0.6,
      tasks: [{ title: 'maybe a task' }],
    });
    assert.equal(lowConfidence.reply, null, 'group chat needs a higher bar than a DM');
    assert.equal((await queryTasks(env.db, { familyId: env.familyId })).length, 0);
  });

  it('creates a task assigned to the named member, in a new list', async () => {
    const ctx = ctxFor(env.familyId, env.arjun, 'dm', 'Priya can you renew the insurance by friday, urgent');
    const result = await applyParsed(env.db, ctx, {
      intent: 'new_task',
      confidence: 0.9,
      tasks: [
        { title: 'Renew car insurance', list: 'Business', assignee: 'Priya', priority: 'high', due_date: '2026-09-11' },
      ],
    });
    assert.ok(result.reply);
    assert.deepEqual(result.notify.map((n) => n.memberId), [env.priya.id], 'the assignee is told now, not at 9am');
    const [task] = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(task!.assigned_to, env.priya.id);
    assert.equal(task!.list_name, 'Business');
    assert.equal(task!.priority, 'high');
    assert.equal(task!.due_at, '2026-09-11T00:00:00.000Z');
  });

  it('still saves the message when the agent extracts no task from it', async () => {
    // Observed live: intent new_task at 0.90 confidence with an empty tasks
    // array. Dropping it loses work the person plainly asked for.
    const ctx = ctxFor(env.familyId, env.arjun, 'dm', 'Schedule appt for HVAC cleaning by Sep 30th');
    const result = await applyParsed(env.db, ctx, {
      intent: 'new_task',
      confidence: 0.9,
      tasks: [],
    });
    assert.ok(result.reply, 'a confident new_task must never vanish');
    const [task] = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(task!.title, 'Schedule appt for HVAC cleaning by Sep 30th');
    assert.equal(task!.assigned_to, env.arjun.id);
  });

  it('leaves a group-addressed task open to the family', async () => {
    const ctx = ctxFor(env.familyId, env.arjun, 'group', 'someone needs to sort the recycling');
    await applyParsed(env.db, ctx, {
      intent: 'new_task',
      confidence: 0.9,
      tasks: [{ title: 'Sort the recycling', assignee: 'group' }],
    });
    const [task] = await queryTasks(env.db, { familyId: env.familyId, unclaimedOnly: true });
    assert.equal(task!.assignee_kind, 'group');
  });

  it('assigns an unattributed DM task to the speaker', async () => {
    const ctx = ctxFor(env.familyId, env.priya, 'dm', 'I need to call the plumber');
    await applyParsed(env.db, ctx, {
      intent: 'new_task',
      confidence: 0.9,
      tasks: [{ title: 'Call the plumber' }],
    });
    const [task] = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(task!.assigned_to, env.priya.id);
  });

  it('moves an existing task and records the note', async () => {
    await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'Renew car insurance',
      assigneeKind: 'member',
      assignedTo: env.priya.id,
    });
    const ctx = ctxFor(env.familyId, env.priya, 'dm', 'stuck on the car insurance, need the policy number');
    const result = await applyParsed(env.db, ctx, {
      intent: 'status_update',
      confidence: 0.9,
      target_task_hint: 'car insurance',
      new_state: 'blocked',
      comment: 'needs the policy number',
    });
    assert.match(result.reply!.text, /Blocked/);
    const [task] = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(task!.state, 'blocked');
  });

  it('says so instead of guessing when no task matches', async () => {
    await createTask(env.db, { familyId: env.familyId, listId: env.home.id, title: 'Renew car insurance', assigneeKind: 'member', assignedTo: env.arjun.id });
    const ctx = ctxFor(env.familyId, env.arjun, 'dm', 'finished the loft conversion');
    const result = await applyParsed(env.db, ctx, {
      intent: 'status_update',
      confidence: 0.9,
      target_task_hint: 'loft conversion',
      new_state: 'done',
    });
    assert.match(result.reply!.text, /can't find a task/);
    assert.deepEqual(result.notify, [], 'a failed match must not DM anyone');
    const [task] = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(task!.state, 'todo');
  });

  it('tells the other party when a task bounces back', async () => {
    await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'Renew car insurance',
      createdBy: env.arjun.id,
      assigneeKind: 'member',
      assignedTo: env.priya.id,
    });
    const ctx = ctxFor(env.familyId, env.priya, 'dm', 'blocked on the car insurance');
    const result = await applyParsed(env.db, ctx, {
      intent: 'status_update',
      confidence: 0.9,
      target_task_hint: 'car insurance',
      new_state: 'blocked',
    });
    assert.deepEqual(
      result.notify.map((n) => n.memberId),
      [env.arjun.id],
      'whoever raised it should hear that it is stuck',
    );
  });

  it('does not notify the speaker about their own task', async () => {
    const ctx = ctxFor(env.familyId, env.arjun, 'dm', 'I need to call the plumber');
    const result = await applyParsed(env.db, ctx, {
      intent: 'new_task',
      confidence: 0.9,
      tasks: [{ title: 'Call the plumber', assignee: 'me' }],
    });
    assert.deepEqual(result.notify, []);
  });

  it('moves a deadline on an existing task instead of creating one', async () => {
    await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'HVAC cleaning appointment',
      createdBy: env.arjun.id,
      assigneeKind: 'member',
      assignedTo: env.arjun.id,
      dueAt: '2026-09-09T00:00:00.000Z',
    });
    const ctx = ctxFor(env.familyId, env.arjun, 'dm', 'push the HVAC one to the 30th');
    const result = await applyParsed(env.db, ctx, {
      intent: 'comment',
      confidence: 0.9,
      target_task_hint: 'HVAC cleaning',
      new_due_date: '2026-09-30',
    });
    const tasks = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(tasks.length, 1, 'moving a date must not create a second task');
    assert.equal(tasks[0]!.due_at, '2026-09-30T00:00:00.000Z');
    assert.match(result.reply!.text, /2026-09-30/);
  });

  it('gives a task with no named owner to whoever raised it', async () => {
    const ctx = ctxFor(env.familyId, env.arjun, 'group', 'we need to book the car service');
    await applyParsed(env.db, ctx, {
      intent: 'new_task',
      confidence: 0.9,
      tasks: [{ title: 'Book the car service' }],
    });
    const [task] = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(task!.assigned_to, env.arjun.id, 'unassigned reads as a bug to the author');
    assert.equal(task!.assignee_kind, 'member');
  });

  it('answers a query without writing anything', async () => {
    await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'Book dentist',
      assigneeKind: 'member',
      assignedTo: env.arjun.id,
    });
    const reply = await answerQuery(env.db, env.arjun, { scope: 'next' });
    assert.match(reply.text, /Book dentist/);
  });
});

describe('task matching', () => {
  const task = (id: string, title: string, assigned: string | null = null) =>
    ({ id, title, description: null, list_name: 'Home', assigned_to: assigned }) as TaskView;

  it('matches on distinctive words and rejects a weak overlap', () => {
    const tasks = [task('a', 'Renew car insurance'), task('b', 'Book dentist appointment')];
    assert.equal(matchTask(tasks, 'the car insurance thing')?.id, 'a');
    assert.equal(matchTask(tasks, 'what about dinner'), null);
  });

  it('breaks a tie toward the asker\'s own task', () => {
    const tasks = [task('a', 'Book dentist', 'mem_1'), task('b', 'Book dentist', 'mem_2')];
    assert.equal(matchTask(tasks, 'book dentist', 'mem_2')?.id, 'b');
  });
});

describe('digest agent output is not trusted', () => {
  it('drops invented ids and restores dropped ones', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as TaskView[];
    const plan = sanitize({ intro: 'hi', order: ['c', 'zzz', 'c', 'a'] }, tasks);
    assert.deepEqual(plan.order, ['c', 'a', 'b']);
  });
});

describe('telegram layer', () => {
  it('round-trips every action inside the callback_data limit', () => {
    const actions = [
      { kind: 'task_done', taskId: 'tsk_0123456789abcdef' },
      { kind: 'task_claim', taskId: 'tsk_0123456789abcdef' },
      { kind: 'digest_list_toggle', listId: 'lst_0123456789abcdef' },
      { kind: 'noop' },
    ] as const;
    for (const action of actions) {
      const encoded = encodeAction(action);
      assert.ok(new TextEncoder().encode(encoded).length <= 64, encoded);
      assert.deepEqual(decodeAction(encoded), action);
    }
    assert.deepEqual(decodeAction('garbage'), { kind: 'noop' });
  });

  it('reads a group message and strips the bot handle', () => {
    const parsed = parseUpdate(
      {
        update_id: 7,
        message: {
          message_id: 22,
          from: { id: 1001, first_name: 'Arjun' },
          chat: { id: -500, type: 'supergroup' },
          text: '@FamTaskBot what is next',
        },
      },
      'FamTaskBot',
    );
    assert.equal(parsed.message?.chatType, 'group');
    assert.equal(parsed.message?.text, 'what is next');
    assert.equal(parsed.message?.addressedToBot, true);
  });

  it('ignores messages from other bots', () => {
    const parsed = parseUpdate({
      update_id: 8,
      message: {
        message_id: 23,
        from: { id: 99, is_bot: true, first_name: 'Other' },
        chat: { id: -500, type: 'group' },
        text: 'beep',
      },
    });
    assert.equal(parsed.message, undefined);
  });

  it('picks up being added to a group', () => {
    const parsed = parseUpdate({
      update_id: 9,
      my_chat_member: { chat: { id: -500, type: 'supergroup' }, new_chat_member: { status: 'member' } },
    });
    assert.deepEqual(parsed.groupMembership, { chatId: '-500', chatType: 'group', joined: true });
  });
});

describe('group prefilter', () => {
  it('lets a real ask through and holds back chatter', () => {
    assert.ok(looksActionable('can you book the dentist tomorrow'));
    assert.ok(looksActionable("don't forget the recycling goes out tonight"));
    assert.ok(!looksActionable('haha'));
    assert.ok(!looksActionable('ok sounds good to me then'));
  });
});

describe('member matching', () => {
  it('matches on first name and handle, not on nothing', async () => {
    const members = [
      { id: 'm1', name: 'Priya Raman' },
      { id: 'm2', name: 'Arjun' },
    ] as FamilyMember[];
    assert.equal(matchMemberByName(members, 'priya')?.id, 'm1');
    assert.equal(matchMemberByName(members, '@Arjun')?.id, 'm2');
    assert.equal(matchMemberByName(members, 'nobody'), null);
  });
});


describe('agent outage', () => {
  /** Reproduces a real run: a valid key on an account with no credit. The
   *  API returns 400 with a billing message, not a dedicated error class. */
  const billingError = Object.assign(
    new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error",' +
        '"message":"Your credit balance is too low to access the Anthropic API."}}',
    ),
    { status: 400 },
  );

  function stubClient(err: unknown): Anthropic {
    return { messages: { create: async () => { throw err; } } } as unknown as Anthropic;
  }

  function recorder(): { channel: MessagingChannel; sent: OutboundMessage[] } {
    const sent: OutboundMessage[] = [];
    return {
      sent,
      channel: {
        name: 'telegram',
        async send(message) { sent.push(message); return String(sent.length); },
        async acknowledge() {},
      },
    };
  }

  it('names the cause instead of leaking the raw API error', () => {
    assert.match(describeAgentFailure(billingError), /out of credit/);
    assert.match(describeAgentFailure(new Error('boom')), /unknown reason/);
  });

  it('passes through the field a request-shape 400 names', () => {
    const schemaError = Object.assign(
      new Error(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
          '"tools.0.custom.input_schema: type arrays are not supported"}}',
      ),
      { status: 400 },
    );
    // Billing and a schema bug are both 400s; only one of them is fixable by
    // the person reading the message, so they must not read alike.
    assert.match(describeAgentFailure(schemaError), /type arrays are not supported/);
    assert.doesNotMatch(describeAgentFailure(schemaError), /out of credit/);
  });

  it('answers the DM and does not throw, so Telegram stops retrying', async () => {
    const env = await setup();
    const { channel, sent } = recorder();
    const deps: AppDeps = { db: env.db, channel, anthropic: stubClient(billingError) };

    await handleInboundMessage(deps, {
      chatId: '1001',
      chatType: 'dm',
      userId: '1001',
      userDisplayName: 'Arjun',
      text: 'book the dentist for friday please',
      messageId: 'm1',
      addressedToBot: true,
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /out of credit/);
    assert.match(sent[0]!.text, /Nothing was saved/);
    assert.equal((await queryTasks(env.db, { familyId: env.familyId })).length, 0);
  });

  it('stays silent in the group rather than shouting billing errors', async () => {
    const env = await setup();
    const { channel, sent } = recorder();
    const deps: AppDeps = { db: env.db, channel, anthropic: stubClient(billingError) };

    await handleInboundMessage(deps, {
      chatId: '-500',
      chatType: 'group',
      userId: '1002',
      userDisplayName: 'Priya',
      text: 'can you please book the dentist tomorrow',
      messageId: 'm2',
      addressedToBot: true,
    });

    assert.deepEqual(sent, []);
  });

  it('never leaves a DM unanswered, even when it decides to do nothing', async () => {
    const env = await setup();
    const { channel, sent } = recorder();
    // A client that succeeds but classifies the message as chit-chat.
    const chatty = {
      messages: {
        create: async () => ({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              name: 'record_message',
              input: { intent: 'chitchat', confidence: 0.95 },
            },
          ],
        }),
      },
    } as unknown as Anthropic;

    await handleInboundMessage(
      { db: env.db, channel, anthropic: chatty },
      {
        chatId: '1001',
        chatType: 'dm',
        userId: '1001',
        userDisplayName: 'Arjun',
        text: 'haha that is funny',
        messageId: 'm9',
        addressedToBot: true,
      },
    );

    assert.equal(sent.length, 1, 'a DM must always get an answer');
    assert.match(sent[0]!.text, /didn't read that as a task/);
  });

  it('stays quiet on the same message in the group', async () => {
    const env = await setup();
    const { channel, sent } = recorder();
    const chatty = {
      messages: {
        create: async () => ({
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', name: 'record_message', input: { intent: 'chitchat', confidence: 0.95 } },
          ],
        }),
      },
    } as unknown as Anthropic;

    await handleInboundMessage(
      { db: env.db, channel, anthropic: chatty },
      {
        chatId: '-500',
        chatType: 'group',
        userId: '1002',
        userDisplayName: 'Priya',
        text: 'haha that is funny, can you believe it',
        messageId: 'm10',
        addressedToBot: true,
      },
    );

    assert.deepEqual(sent, [], 'chit-chat in the group is exactly what should be ignored');
  });

  it('still serves slash commands with the agent down', async () => {
    const env = await setup();
    const { channel, sent } = recorder();
    const deps: AppDeps = { db: env.db, channel, anthropic: stubClient(billingError) };

    await handleInboundMessage(deps, {
      chatId: '1001',
      chatType: 'dm',
      userId: '1001',
      userDisplayName: 'Arjun',
      text: '/add Renew the car insurance',
      messageId: 'm3',
      addressedToBot: true,
    });

    assert.match(sent[0]!.text, /Renew the car insurance/);
    assert.equal((await queryTasks(env.db, { familyId: env.familyId })).length, 1);
  });
});


describe('strict tool schema', () => {
  /**
   * Two rules, both learned the hard way against the live API:
   * a property missing from `required` is never emitted at all, and a JSON
   * Schema type array is rejected with a 400. Neither shows up in a unit
   * test of the parser, so assert the schema shape directly.
   */
  function walk(node: unknown, path: string, check: (o: any, p: string) => void): void {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj['type'] === 'object') check(obj, path);
    if (Array.isArray(obj['type'])) {
      assert.fail(`${path}: type arrays are rejected by strict tool use — use anyOf`);
    }
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}.${key}[${i}]`, check));
      else walk(value, `${path}.${key}`, check);
    }
  }

  it('requires every property of every object', () => {
    walk(TOOL_SCHEMA, 'root', (obj, path) => {
      const props = Object.keys((obj.properties ?? {}) as object);
      const required = (obj.required ?? []) as string[];
      const missing = props.filter((p) => !required.includes(p));
      assert.deepEqual(missing, [], `${path}: properties missing from required`);
      assert.equal(obj.additionalProperties, false, `${path}: needs additionalProperties:false`);
    });
  });

  it('uses no type arrays anywhere', () => {
    walk(TOOL_SCHEMA, 'root', () => {});
  });

  it('still covers every field the engine reads', () => {
    const props = Object.keys(TOOL_SCHEMA.properties as object);
    for (const field of [
      'intent', 'confidence', 'tasks', 'target_task_hint',
      'new_state', 'new_due_date', 'new_assignee', 'comment', 'query',
    ]) {
      assert.ok(props.includes(field), `schema lost ${field}`);
    }
  });
});


describe('model capability gating', () => {
  it('omits effort on models that reject it', () => {
    // Sending output_config.effort to these returns a 400, which would make
    // "try a cheaper model" fail rather than save money.
    assert.equal(supportsEffort('claude-haiku-4-5'), false);
    assert.equal(supportsEffort('claude-sonnet-4-5'), false);
    assert.equal(supportsEffort('claude-opus-5'), true);
    assert.equal(supportsEffort('claude-sonnet-5'), true);
  });
});


describe('one-way mirror', () => {
  /** Records what a target was asked to do, and can be told to fail. */
  function fakeTarget(failOn?: string) {
    const calls: string[] = [];
    let n = 0;
    return {
      calls,
      target: {
        name: 'fake',
        async create(task: any) {
          if (task.title === failOn) throw new Error('target rejected it');
          calls.push(`create:${task.title}`);
          n += 1;
          return `ext_${n}`;
        },
        async update(id: string, task: any) { calls.push(`update:${task.title}`); },
        async close(id: string) { calls.push(`close:${id}`); },
        async reopen(id: string) { calls.push(`reopen:${id}`); },
      } as any,
    };
  }

  it('creates once, then skips while nothing changes', async () => {
    const env = await setup();
    const { target, calls } = fakeTarget();
    await createTask(env.db, {
      familyId: env.familyId, listId: env.home.id, title: 'Book the window cleaner',
      assigneeKind: 'member', assignedTo: env.arjun.id,
    });

    const first = await reconcile(env.db, target, env.familyId);
    assert.equal(first.created, 1);

    const second = await reconcile(env.db, target, env.familyId);
    assert.equal(second.created, 0);
    assert.equal(second.skipped, 1, 'an unchanged task must not be pushed again');
    assert.deepEqual(calls, ['create:Book the window cleaner']);
  });

  it('pushes an edit, and closes when the task is done', async () => {
    const env = await setup();
    const { target, calls } = fakeTarget();
    const task = await createTask(env.db, {
      familyId: env.familyId, listId: env.home.id, title: 'Renew the domain',
      assigneeKind: 'member', assignedTo: env.arjun.id,
    });
    await reconcile(env.db, target, env.familyId);

    await setState(env.db, task.id, 'blocked', env.arjun.id);
    const edited = await reconcile(env.db, target, env.familyId);
    assert.equal(edited.updated, 1);

    await setState(env.db, task.id, 'done', env.arjun.id);
    const done = await reconcile(env.db, target, env.familyId);
    assert.equal(done.closed, 1);
    assert.deepEqual(calls, ['create:Renew the domain', 'update:Renew the domain', 'close:ext_1']);
  });

  it('reopens a task that comes back from done', async () => {
    const env = await setup();
    const { target, calls } = fakeTarget();
    const task = await createTask(env.db, {
      familyId: env.familyId, listId: env.home.id, title: 'Pay the water bill',
    });
    await reconcile(env.db, target, env.familyId);
    await setState(env.db, task.id, 'done', env.arjun.id);
    await reconcile(env.db, target, env.familyId);
    await setState(env.db, task.id, 'todo', env.arjun.id);

    const back = await reconcile(env.db, target, env.familyId);
    assert.equal(back.reopened, 1);
    assert.ok(calls.includes('reopen:ext_1'));
  });

  it('never creates a task that was already finished', async () => {
    const env = await setup();
    const { target, calls } = fakeTarget();
    const task = await createTask(env.db, {
      familyId: env.familyId, listId: env.home.id, title: 'Already handled',
    });
    await setState(env.db, task.id, 'done', env.arjun.id);

    const report = await reconcile(env.db, target, env.familyId);
    assert.equal(report.created, 0);
    assert.deepEqual(calls, [], 'closed history should not be replayed into the mirror');
  });

  it('retries a failed push instead of losing it', async () => {
    const env = await setup();
    await createTask(env.db, {
      familyId: env.familyId, listId: env.home.id, title: 'Flaky one',
    });

    const failing = fakeTarget('Flaky one');
    const bad = await reconcile(env.db, failing.target, env.familyId);
    assert.equal(bad.failed, 1);
    assert.equal(bad.created, 0);

    // Same target name, now healthy: the task must still be pending.
    const healthy = fakeTarget();
    const good = await reconcile(env.db, healthy.target, env.familyId);
    assert.equal(good.created, 1, 'a failure must not be recorded as synced');
  });

  it('mirrors the escalated priority, not the stored one', async () => {
    const env = await setup();
    const seen: any[] = [];
    const target = {
      name: 'fake',
      async create(task: any) { seen.push(task); return 'ext_1'; },
      async update() {}, async close() {}, async reopen() {},
    } as any;

    await createTask(env.db, {
      familyId: env.familyId, listId: env.home.id, title: 'Renew the passport',
      priority: 'low', dueAt: '2026-09-13T00:00:00.000Z',
    });
    await reconcile(env.db, target, env.familyId, { now: new Date('2026-09-12T10:00:00Z') });
    assert.equal(seen[0].priority, 'high', 'due tomorrow outranks the stored priority');
  });

  it('changes the hash only for fields the target renders', () => {
    const base: any = {
      id: 't1', title: 'A', description: null, listName: 'Family', assigneeName: 'Arjun',
      state: 'todo', priority: 'medium', dueAt: null, closed: false,
    };
    assert.equal(shapeHash(base), shapeHash({ ...base, id: 'different' }));
    assert.notEqual(shapeHash(base), shapeHash({ ...base, title: 'B' }));
    assert.notEqual(shapeHash(base), shapeHash({ ...base, assigneeName: 'Priya' }));
    assert.notEqual(shapeHash(base), shapeHash({ ...base, closed: true }));
  });
});


describe('task lines say who and where, only when it helps', () => {
  const task = (over: Partial<TaskView>): TaskView =>
    ({
      id: 't1', title: 'Pick up birthday gift', description: null, list_name: 'Family',
      assignee_kind: 'member', assignee_name: 'Arjun', assigned_to: 'mem_1',
      state: 'todo', priority: 'medium', due_at: null, created_at: '2026-09-01T00:00:00Z',
      ...over,
    }) as TaskView;

  it('drops the list tag when every task is in the same list', () => {
    // It reads as an assignee, and repeated on every line it says nothing.
    const one = [task({}), task({ id: 't2' })];
    assert.equal(multipleLists(one), false);
    assert.ok(!taskLine(one[0]!, { showList: multipleLists(one) }).includes('[Family]'));

    const two = [task({}), task({ id: 't2', list_name: 'Business' })];
    assert.equal(multipleLists(two), true);
    assert.ok(taskLine(two[0]!, { showList: multipleLists(two) }).includes('[Family]'));
  });

  it('always names the owner, including in the reader\'s own digest', () => {
    // Suppressing it "because they are all yours" makes the reader work out
    // a rule to answer the first question a family asks.
    assert.ok(taskLine(task({})).endsWith('— Arjun'));
    assert.ok(taskLine(task({ assignee_name: 'Preethi Raja' })).endsWith('— Preethi'));
  });

  it('flags work nobody owns', () => {
    assert.ok(
      taskLine(task({ assignee_kind: 'group', assignee_name: null })).includes('up for grabs'),
    );
    assert.ok(
      taskLine(task({ assignee_kind: 'unassigned', assignee_name: null })).includes('unassigned'),
    );
  });
});

describe('button taps', () => {
  /** A channel that edits in place, so a test can read the screen back. */
  function screen() {
    const sent: OutboundMessage[] = [];
    const edits: RenderedMessage[] = [];
    const toasts: (string | undefined)[] = [];
    const channel: MessagingChannel = {
      name: 'telegram',
      async send(message) {
        sent.push(message);
        return String(sent.length);
      },
      async acknowledge(_token, text) {
        toasts.push(text);
      },
      async update(_chatId, _messageId, message) {
        edits.push(message);
      },
    };
    return { channel, sent, edits, toasts, last: () => edits[edits.length - 1] };
  }

  async function stage() {
    const base = await setup();
    const s = screen();
    const deps: AppDeps = { db: base.db, channel: s.channel, anthropic: null };
    const task = await createTask(base.db, {
      familyId: base.familyId,
      listId: base.home.id,
      title: 'Book the HVAC service',
      createdBy: base.arjun.id,
      assigneeKind: 'member',
      assignedTo: base.arjun.id,
    });
    // Stand in for a digest the bot already sent as message 7.
    const board = renderTaskList('Your tasks', [await getTaskView(base.db, task.id)]);
    await rememberView(base.db, 'c1', '7', board.view!);
    return { ...base, ...s, deps, task };
  }

  function tap(action: Action, userId = '1001') {
    return {
      chatId: 'c1',
      chatType: 'dm' as const,
      userId,
      userDisplayName: 'Arjun',
      action,
      messageId: '7',
      ackToken: 'cb1',
    };
  }

  it('asks before finishing a task, and changes nothing until confirmed', async () => {
    const st = await stage();
    await handleInboundAction(st.deps, tap({ kind: 'task_done', taskId: st.task.id }));

    assert.match(st.last()!.text, /Mark this done\?/);
    assert.equal((await getTaskView(st.db, st.task.id)).state, 'todo');

    const labels = st.last()!.buttons!.flat().map((b) => b.label);
    assert.ok(labels.some((l) => /Yes/.test(l)) && labels.some((l) => /Not yet/.test(l)));
  });

  it('backs out of the confirmation leaving the task alone', async () => {
    const st = await stage();
    await handleInboundAction(st.deps, tap({ kind: 'task_done', taskId: st.task.id }));
    await handleInboundAction(st.deps, tap({ kind: 'view_back' }));

    assert.equal((await getTaskView(st.db, st.task.id)).state, 'todo');
    assert.match(st.last()!.text, /Your tasks/);
  });

  it('redraws the message so a finished task reads as finished', async () => {
    const st = await stage();
    await handleInboundAction(st.deps, tap({ kind: 'task_done', taskId: st.task.id }));
    await handleInboundAction(st.deps, tap({ kind: 'task_done_confirm', taskId: st.task.id }));

    assert.equal((await getTaskView(st.db, st.task.id)).state, 'done');
    // The screen itself says so -- not just the toast, which vanishes.
    assert.match(st.last()!.text, /✓ Book the HVAC service/);
    assert.match(st.last()!.text, /Your tasks/);
    assert.ok(st.toasts.some((t) => t?.includes('Done: Book the HVAC service')));
  });

  it('offers blocked, needs-info and reassign behind the ⋯ button', async () => {
    const st = await stage();
    await handleInboundAction(st.deps, tap({ kind: 'task_menu', taskId: st.task.id }));

    const labels = st.last()!.buttons!.flat().map((b) => b.label);
    assert.ok(labels.some((l) => /Blocked/.test(l)));
    assert.ok(labels.some((l) => /Needs info/.test(l)));
    assert.ok(labels.some((l) => /Reassign/.test(l)));
    assert.ok(labels.some((l) => /Back/.test(l)));
  });

  it('blocks a task from the menu and returns to the listing', async () => {
    const st = await stage();
    await handleInboundAction(st.deps, tap({ kind: 'task_menu', taskId: st.task.id }));
    await handleInboundAction(st.deps, tap({ kind: 'task_block', taskId: st.task.id }));

    assert.equal((await getTaskView(st.db, st.task.id)).state, 'blocked');
    assert.match(st.last()!.text, /Your tasks/);
    assert.match(st.last()!.text, /⛔ Book the HVAC service/);
  });

  it('reassigns to another family member and tells them', async () => {
    const st = await stage();
    await handleInboundAction(st.deps, tap({ kind: 'task_reassign', taskId: st.task.id }));

    const labels = st.last()!.buttons!.flat().map((b) => b.label);
    assert.ok(labels.includes('Priya'));
    assert.ok(labels.some((l) => /Up for grabs/.test(l)));

    await handleInboundAction(
      st.deps,
      tap({ kind: 'task_assign', taskId: st.task.id, to: st.priya.id }),
    );
    const after = await getTaskView(st.db, st.task.id);
    assert.equal(after.assigned_to, st.priya.id);
    assert.match(st.last()!.text, /— Priya/);
    assert.ok(st.sent.some((m) => m.chatId === '1002' && /passed you/.test(m.text)));
  });

  it('still works on a message sent before views were recorded', async () => {
    const st = await stage();
    const orphan = { ...tap({ kind: 'task_done_confirm', taskId: st.task.id }), messageId: '999' };
    await handleInboundAction(st.deps, orphan);

    assert.equal((await getTaskView(st.db, st.task.id)).state, 'done');
    assert.ok(st.toasts.some((t) => t?.includes('Done:')));
  });

  it('round-trips every button action through the wire encoding', () => {
    const actions: Action[] = [
      { kind: 'task_done', taskId: 'tsk_1' },
      { kind: 'task_done_confirm', taskId: 'tsk_1' },
      { kind: 'task_block', taskId: 'tsk_1' },
      { kind: 'task_ask', taskId: 'tsk_1' },
      { kind: 'task_menu', taskId: 'tsk_1' },
      { kind: 'task_reassign', taskId: 'tsk_1' },
      { kind: 'task_assign', taskId: 'tsk_1', to: 'mem_2' },
      { kind: 'view_back' },
    ];
    for (const action of actions) {
      const wire = encodeAction(action);
      assert.ok(Buffer.byteLength(wire) <= 64, `${wire} exceeds Telegram's callback_data cap`);
      assert.deepEqual(decodeAction(wire), action);
    }
  });
});

describe('waiting on someone outside the family', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });

  it('records the outsider and leaves a family member chasing it', async () => {
    const ctx = ctxFor(env.familyId, env.arjun, 'dm', 'Get the plumber to look at the leak');
    await applyParsed(env.db, ctx, {
      intent: 'new_task',
      confidence: 0.9,
      tasks: [{ title: 'Fix the kitchen leak', waiting_on: 'the plumber' }],
    });
    const [task] = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(task!.waiting_on, 'the plumber');
    // Someone in the family still owns it, or it reaches nobody's digest.
    assert.equal(task!.assigned_to, env.arjun.id);
  });

  it('treats an unknown name in assignee as an outsider, not as the whole family', async () => {
    const ctx = ctxFor(env.familyId, env.arjun, 'dm', 'Ask the landscaper to quote the back garden');
    await applyParsed(env.db, ctx, {
      intent: 'new_task',
      confidence: 0.9,
      tasks: [{ title: 'Quote for the back garden', assignee: 'the landscaper' }],
    });
    const [task] = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(task!.waiting_on, 'the landscaper');
    assert.equal(task!.assignee_kind, 'member', 'a task nobody in the family holds gets dropped');
    assert.equal(task!.assigned_to, env.arjun.id);
  });

  it('never lets a family member end up in waiting_on', async () => {
    const ctx = ctxFor(env.familyId, env.arjun, 'dm', 'Priya is chasing the school');
    await applyParsed(env.db, ctx, {
      intent: 'new_task',
      confidence: 0.9,
      // The agent mislabelling a member as the outsider must not hide the
      // real assignment behind free text.
      tasks: [{ title: 'Get the enrolment form', assignee: 'Priya', waiting_on: 'Priya' }],
    });
    const [task] = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(task!.waiting_on, null);
    assert.equal(task!.assigned_to, env.priya.id);
  });

  it('reads a shortened first name as the family member, not as an outsider', async () => {
    const ctx = ctxFor(env.familyId, env.arjun, 'dm', 'Pri can you call the vet');
    await applyParsed(env.db, ctx, {
      intent: 'new_task',
      confidence: 0.9,
      tasks: [{ title: 'Call the vet', assignee: 'Pri' }],
    });
    const [task] = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(task!.assigned_to, env.priya.id);
    assert.equal(task!.waiting_on, null);
  });

  it('still throws a task open to the family when nobody in particular is named', async () => {
    const ctx = ctxFor(env.familyId, env.arjun, 'dm', 'Someone needs to take the bins out');
    await applyParsed(env.db, ctx, {
      intent: 'new_task',
      confidence: 0.9,
      tasks: [{ title: 'Take the bins out', assignee: 'someone' }],
    });
    const [task] = await queryTasks(env.db, { familyId: env.familyId });
    assert.equal(task!.assignee_kind, 'group');
    assert.equal(task!.waiting_on, null);
  });

  it('clears the wait when the outsider comes back', async () => {
    const task = await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'Fix the kitchen leak',
      createdBy: env.arjun.id,
      assigneeKind: 'member',
      assignedTo: env.arjun.id,
      waitingOn: 'the plumber',
    });
    const ctx = ctxFor(env.familyId, env.arjun, 'dm', 'the plumber finally called back');
    await applyParsed(env.db, ctx, {
      intent: 'comment',
      confidence: 0.9,
      target_task_hint: 'kitchen leak',
      comment: 'plumber called back',
      new_waiting_on: 'none',
    });
    assert.equal((await getTaskView(env.db, task.id)).waiting_on, null);
  });

  it('answers "what are we waiting on" with only those tasks', async () => {
    await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'Chase the insurance claim',
      createdBy: env.arjun.id,
      assigneeKind: 'member',
      assignedTo: env.arjun.id,
      waitingOn: 'the insurer',
    });
    await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'Clean the garage',
      createdBy: env.arjun.id,
      assigneeKind: 'member',
      assignedTo: env.arjun.id,
    });
    const answer = await answerQuery(env.db, env.arjun, { scope: 'waiting' });
    assert.match(answer.text, /Chase the insurance claim/);
    assert.doesNotMatch(answer.text, /Clean the garage/);
  });

  it('says who is being waited on, in words, and stops once the task closes', async () => {
    const task = await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'Fix the kitchen leak',
      createdBy: env.arjun.id,
      assigneeKind: 'member',
      assignedTo: env.arjun.id,
      waitingOn: 'the plumber',
    });
    const open = await getTaskView(env.db, task.id);
    assert.match(taskLine(open), /— Arjun · waiting on the plumber$/);

    await setState(env.db, task.id, 'done', env.arjun.id);
    assert.doesNotMatch(taskLine(await getTaskView(env.db, task.id)), /waiting on/);
  });

  it('offers to clear the wait from the menu, and only when there is one', async () => {
    const task = await createTask(env.db, {
      familyId: env.familyId,
      listId: env.home.id,
      title: 'Fix the kitchen leak',
      createdBy: env.arjun.id,
      assigneeKind: 'member',
      assignedTo: env.arjun.id,
    });
    const without = renderTaskMenu(await getTaskView(env.db, task.id));
    assert.ok(!without.buttons!.flat().some((b) => b.action.kind === 'task_waiting_clear'));

    await setWaitingOn(env.db, task.id, 'the plumber', env.arjun.id);
    const withWait = renderTaskMenu(await getTaskView(env.db, task.id));
    const clear = withWait.buttons!.flat().find((b) => b.action.kind === 'task_waiting_clear');
    assert.ok(clear, 'a wait you cannot end from the digest is a wait you retype');
    assert.match(clear!.label, /came back/);
  });

  it('pushes a changed wait to the mirror', () => {
    const base = {
      id: 'tsk_1',
      title: 'Fix the kitchen leak',
      description: null,
      listName: 'Home',
      assigneeName: 'Arjun',
      waitingOn: null,
      state: 'todo' as const,
      priority: 'medium' as const,
      dueAt: null,
      closed: false,
    };
    assert.notEqual(shapeHash(base), shapeHash({ ...base, waitingOn: 'the plumber' }));
  });
});

describe('a family split across two messaging apps', () => {
  /** Records what each adapter was asked to send. */
  function adapter(name: string) {
    const sent: OutboundMessage[] = [];
    const channel: MessagingChannel = {
      name,
      async send(message) {
        sent.push(message);
        return `${name}-${sent.length}`;
      },
      async acknowledge() {},
    };
    return { channel, sent };
  }

  async function household() {
    const { db } = memoryDb();
    const family = await ensureFamily(db, 'Home');
    const arjun = await addMember(db, {
      familyId: family.id,
      name: 'Arjun',
      channel: 'telegram',
      channelUserId: '1001',
      channelChatId: '1001',
    });
    const preethi = await addMember(db, {
      familyId: family.id,
      name: 'Preethi',
      channel: 'whatsapp',
      channelUserId: '15550001111',
      channelChatId: '15550001111',
    });
    for (const m of [arjun, preethi]) {
      await updateMemberPrefs(db, m.id, { timezone: 'UTC', digestHour: 9 });
    }
    const home = await resolveList(db, family.id, null);
    for (const [title, owner] of [['Fix the gate', arjun], ['Call the school', preethi]] as const) {
      await createTask(db, {
        familyId: family.id,
        listId: home.id,
        title,
        createdBy: owner.id,
        assigneeKind: 'member',
        assignedTo: owner.id,
      });
    }
    return { db, family, arjun, preethi };
  }

  const at9am = () => new Date('2026-09-16T09:00:00Z');

  it('sends each person their digest on their own app, from one cron tick', async () => {
    const home = await household();
    const tg = adapter('telegram');
    const wa = adapter('whatsapp');
    const deps: AppDeps = {
      db: home.db,
      channel: tg.channel,
      channels: { telegram: tg.channel, whatsapp: wa.channel },
      anthropic: null,
      now: at9am,
    };

    assert.equal(await runScheduledDigests(deps), 2);
    assert.equal(tg.sent.length, 1);
    assert.equal(wa.sent.length, 1);
    assert.match(tg.sent[0]!.text, /Arjun/);
    assert.equal(tg.sent[0]!.chatId, '1001');
    assert.match(wa.sent[0]!.text, /Preethi/);
    assert.equal(wa.sent[0]!.chatId, '15550001111');
  });

  it('keeps the tasks shared even though the two never share an app', async () => {
    const home = await household();
    const tg = adapter('telegram');
    const wa = adapter('whatsapp');
    const deps: AppDeps = {
      db: home.db,
      channel: tg.channel,
      channels: { telegram: tg.channel, whatsapp: wa.channel },
      anthropic: null,
      now: at9am,
    };
    await runScheduledDigests(deps);
    // Same family_id, same lists, one engine: the split is delivery only.
    assert.match(wa.sent[0]!.text, /Call the school/);
    assert.doesNotMatch(wa.sent[0]!.text, /Fix the gate/);
  });

  it('skips a member whose channel has no adapter rather than failing the run', async () => {
    const home = await household();
    const tg = adapter('telegram');
    // WhatsApp deliberately not wired up, as it would be mid-rollout.
    const deps: AppDeps = {
      db: home.db,
      channel: tg.channel,
      channels: { telegram: tg.channel },
      anthropic: null,
      now: at9am,
    };

    await assert.doesNotReject(() => runScheduledDigests(deps));
    assert.equal(tg.sent.length, 1, 'the wired-up half still gets its digest');
  });

  it('lets someone on one app add someone on another', async () => {
    const { db } = memoryDb();
    const family = await ensureFamily(db, 'Home');
    await addMember(db, {
      familyId: family.id,
      name: 'Arjun',
      channel: 'telegram',
      channelUserId: '1001',
      channelChatId: '1001',
    });
    const tg = adapter('telegram');
    const wa = adapter('whatsapp');
    const deps: AppDeps = {
      db,
      channel: tg.channel,
      channels: { telegram: tg.channel, whatsapp: wa.channel },
      anthropic: null,
    };

    await handleInboundMessage(deps, {
      chatId: '1001',
      chatType: 'dm',
      userId: '1001',
      userDisplayName: 'Arjun',
      text: '/adduser whatsapp:15550001111 Preethi',
      messageId: 'm1',
      addressedToBot: true,
    });
    assert.match(tg.sent[0]!.text, /Added Preethi on whatsapp/);

    const added = await getMemberByChannelId(db, 'whatsapp', '15550001111');
    assert.equal(added?.name, 'Preethi');
    assert.equal(added?.channel, 'whatsapp');
    // And the same id on Telegram is still a different person.
    assert.equal(await getMemberByChannelId(db, 'telegram', '15550001111'), null);
  });

  it('warns when adding someone on a channel it cannot actually reach', async () => {
    const { db } = memoryDb();
    const family = await ensureFamily(db, 'Home');
    await addMember(db, {
      familyId: family.id,
      name: 'Arjun',
      channel: 'telegram',
      channelUserId: '1001',
      channelChatId: '1001',
    });
    const tg = adapter('telegram');
    const deps: AppDeps = { db, channel: tg.channel, channels: { telegram: tg.channel }, anthropic: null };

    await handleInboundMessage(deps, {
      chatId: '1001',
      chatType: 'dm',
      userId: '1001',
      userDisplayName: 'Arjun',
      text: '/adduser whatsapp:15550001111 Preethi',
      messageId: 'm1',
      addressedToBot: true,
    });
    assert.match(tg.sent[0]!.text, /no whatsapp adapter wired up/);
  });

  it('posts the group board to the group\'s own channel, not the cron default', async () => {
    const home = await household();
    const tg = adapter('telegram');
    const wa = adapter('whatsapp');
    // The group is a Telegram group, recorded as such.
    await setGroupChat(home.db, home.family.id, '-500', 'telegram');
    await createTask(home.db, {
      familyId: home.family.id,
      listId: (await resolveList(home.db, home.family.id, null)).id,
      title: 'Book the chimney sweep',
      createdBy: home.arjun.id,
      assigneeKind: 'group',
    });
    // Built with WhatsApp as the inbound default, as a cron easily could be.
    const deps: AppDeps = {
      db: home.db,
      channel: wa.channel,
      channels: { telegram: tg.channel, whatsapp: wa.channel },
      anthropic: null,
      now: at9am,
    };
    await runScheduledDigests(deps);

    const board = tg.sent.find((m) => m.chatId === '-500');
    assert.ok(board, 'the board belongs on Telegram, where the group is');
    assert.match(board!.text, /Book the chimney sweep/);
    assert.ok(!wa.sent.some((m) => m.chatId === '-500'), 'and nowhere else');

    // The consolation for a member with no group on their channel: unclaimed
    // family work still reaches them, in the tail of their own digest.
    const hers = wa.sent.find((m) => m.chatId === '15550001111');
    assert.match(hers!.text, /Up for grabs/);
    assert.match(hers!.text, /Book the chimney sweep/);
  });

  it('routes a reply back to the app the message came in on', async () => {
    const home = await household();
    const wa = adapter('whatsapp');
    const deps: AppDeps = { db: home.db, channel: wa.channel, anthropic: null };

    await handleInboundMessage(deps, {
      chatId: '15550001111',
      chatType: 'dm',
      userId: '15550001111',
      userDisplayName: 'Preethi',
      text: '/tasks',
      messageId: 'm1',
      addressedToBot: true,
    });
    assert.equal(wa.sent.length, 1);
    assert.match(wa.sent[0]!.text, /Call the school/);
  });
});
