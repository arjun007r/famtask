/**
 * The WhatsApp adapter, against a fake Cloud API.
 *
 * Nothing here has met Meta. What it does prove is the shape of every request
 * we would send, and that the three ways WhatsApp is poorer than Telegram --
 * no editing, no toasts, far fewer buttons -- degrade rather than lose
 * anything.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { memoryDb } from '../src/core/db/sqlite.ts';
import { addMember, ensureFamily } from '../src/core/services/registry.ts';
import { resolveList } from '../src/core/services/lists.ts';
import { createTask, getTaskView } from '../src/core/services/tasks.ts';
import { decodeAction, encodeAction } from '../src/channel/actions.ts';
import { collapse, whatsAppChannel } from '../src/whatsapp/channel.ts';
import { WhatsAppApiError, OUTSIDE_WINDOW, splitForWhatsApp, type WhatsAppApi } from '../src/whatsapp/api.ts';
import {
  parseUpdate,
  verifySignature,
  verifySubscription,
  type WaPayload,
} from '../src/whatsapp/webhook.ts';
import { handleInboundAction, handleInboundMessage, type AppDeps } from '../src/app.ts';
import { rememberView } from '../src/core/services/views.ts';
import { renderTaskList } from '../src/channel/format.ts';
import type { Button } from '../src/channel/types.ts';

/** Records every request body, and can be told to fail the next send. */
function fakeApi(opts: { failWith?: WhatsAppApiError } = {}) {
  const sent: Record<string, unknown>[] = [];
  let pending = opts.failWith;
  const api: WhatsAppApi = {
    async send<T>(body: Record<string, unknown>): Promise<T> {
      sent.push(body);
      // Only the first real message is refused; the template retry succeeds.
      if (pending && body.type !== 'template') {
        const err = pending;
        pending = undefined;
        throw err;
      }
      return { messages: [{ id: `wamid.${sent.length}` }] } as T;
    },
  };
  return { api, sent, texts: () => sent.filter((b) => b.type === 'text') };
}

const btn = (label: string, id: string): Button => ({
  label,
  action: { kind: 'task_done', taskId: id },
});

describe('whatsapp: button collapsing', () => {
  it('gives every task one tap before giving any task two', () => {
    // The board renders [✓ task] [⋯] per row; WhatsApp allows ten rows total.
    const rows: Button[][] = Array.from({ length: 8 }, (_, i) => [
      btn(`done ${i}`, `tsk_${i}`),
      { label: '⋯', action: { kind: 'task_menu', taskId: `tsk_${i}` } },
    ]);
    const flat = collapse(rows).slice(0, 10);
    const primaries = flat.filter((b) => b.action.kind === 'task_done');
    assert.equal(primaries.length, 8, 'no task loses its main action to another task’s menu');
    assert.equal(flat.length, 10);
  });

  it('keeps row order within a column', () => {
    const flat = collapse([[btn('a', 'tsk_a')], [btn('b', 'tsk_b')], [btn('c', 'tsk_c')]]);
    assert.deepEqual(flat.map((b) => b.label), ['a', 'b', 'c']);
  });

  it('handles ragged and empty keyboards', () => {
    assert.deepEqual(collapse([]), []);
    const flat = collapse([[btn('a', 'tsk_a'), btn('b', 'tsk_b')], [btn('c', 'tsk_c')]]);
    assert.deepEqual(flat.map((b) => b.label), ['a', 'c', 'b']);
  });
});

describe('whatsapp: sending', () => {
  it('uses reply buttons for three or fewer', async () => {
    const { api, sent } = fakeApi();
    await whatsAppChannel(api).send({
      chatId: '15550001111',
      text: 'Mark this done?',
      buttons: [[btn('Yes', 'tsk_1'), { label: 'No', action: { kind: 'view_back' } }]],
    });
    const body = sent[0] as any;
    assert.equal(body.type, 'interactive');
    assert.equal(body.interactive.type, 'button');
    assert.equal(body.interactive.action.buttons.length, 2);
    assert.equal(body.interactive.action.buttons[0].reply.id, encodeAction({ kind: 'task_done', taskId: 'tsk_1' }));
  });

  it('switches to a list past three, and never exceeds ten rows', async () => {
    const { api, sent } = fakeApi();
    await whatsAppChannel(api).send({
      chatId: '15550001111',
      text: 'Your tasks',
      buttons: Array.from({ length: 14 }, (_, i) => [btn(`task ${i}`, `tsk_${i}`)]),
    });
    const body = sent[0] as any;
    assert.equal(body.interactive.type, 'list');
    assert.equal(body.interactive.action.sections[0].rows.length, 10);
  });

  it('respects every length cap Meta rejects on', async () => {
    const { api, sent } = fakeApi();
    const longLabel = 'Schedule the annual boiler service and inspection';
    await whatsAppChannel(api).send({
      chatId: '15550001111',
      text: 'Your tasks',
      buttons: [
        [btn(longLabel, 'tsk_1')],
        [btn(longLabel, 'tsk_2')],
        [btn(longLabel, 'tsk_3')],
        [btn(longLabel, 'tsk_4')],
      ],
    });
    const rows = (sent[0] as any).interactive.action.sections[0].rows;
    for (const row of rows) {
      assert.ok(row.title.length <= 24, `row title too long: ${row.title}`);
      assert.ok(row.id.length <= 200);
      assert.ok(row.title.length > 0);
    }
  });

  it('never sends an interactive body over the 1024 cap', async () => {
    const { api, sent } = fakeApi();
    await whatsAppChannel(api).send({
      chatId: '15550001111',
      text: 'x'.repeat(2000),
      buttons: [[btn('Done', 'tsk_1')]],
    });
    const interactive = sent.find((b: any) => b.type === 'interactive') as any;
    assert.ok(interactive, 'the buttons still go out');
    assert.ok(interactive.interactive.body.text.length <= 1024);
    assert.ok(sent.some((b: any) => b.type === 'text'), 'and the long text goes as plain messages');
  });

  it('sends plain text when there are no buttons', async () => {
    const { api, sent } = fakeApi();
    const id = await whatsAppChannel(api).send({ chatId: '15550001111', text: 'Noted.' });
    assert.equal((sent[0] as any).type, 'text');
    assert.equal(id, 'wamid.1');
  });

  it('cannot edit, so the engine is never told it can', () => {
    assert.equal(whatsAppChannel(fakeApi().api).update, undefined);
    assert.equal(whatsAppChannel(fakeApi().api).toasts, false);
  });
});

describe('whatsapp: the 24-hour window', () => {
  const closed = new WhatsAppApiError(400, OUTSIDE_WINDOW, 're-engagement message');

  it('falls back to the template when the window has closed', async () => {
    const { api, sent } = fakeApi({ failWith: closed });
    const id = await whatsAppChannel(api).send({
      chatId: '15550001111',
      text: "Morning Preethi — here's your day.\n\n1. ○ Fix the gate — Preethi",
      buttons: [[btn('Fix the gate', 'tsk_1')]],
      fallback: {
        name: 'famtask_daily_digest',
        params: ['Preethi', '3'],
        action: { kind: 'digest_show' },
      },
    });
    const template = sent.find((b: any) => b.type === 'template') as any;
    assert.ok(template, 'the digest is not simply lost');
    assert.equal(template.template.name, 'famtask_daily_digest');
    assert.deepEqual(
      template.template.components[0].parameters.map((p: any) => p.text),
      ['Preethi', '3'],
    );
    const button = template.template.components[1];
    assert.equal(button.sub_type, 'quick_reply');
    assert.deepEqual(decodeAction(button.parameters[0].payload), { kind: 'digest_show' });
    assert.equal(id, `wamid.${sent.length}`);
  });

  it('never puts a newline in a template parameter, which Meta rejects', async () => {
    const { api, sent } = fakeApi({ failWith: closed });
    await whatsAppChannel(api).send({
      chatId: '15550001111',
      text: 'anything',
      fallback: { name: 't', params: ['line one\nline two\ttabbed'] },
    });
    const template = sent.find((b: any) => b.type === 'template') as any;
    const value = template.template.components[0].parameters[0].text;
    assert.doesNotMatch(value, /[\n\r\t]/);
    assert.equal(value, 'line one line two tabbed');
  });

  it('rethrows any other failure rather than papering over it', async () => {
    const { api } = fakeApi({ failWith: new WhatsAppApiError(401, 190, 'bad token') });
    await assert.rejects(
      () => whatsAppChannel(api).send({ chatId: '1', text: 'hi', fallback: { name: 't' } }),
      /bad token/,
    );
  });

  it('does not invent a template when none was supplied', async () => {
    const { api } = fakeApi({ failWith: closed });
    await assert.rejects(() => whatsAppChannel(api).send({ chatId: '1', text: 'hi' }), /131047/);
  });
});

describe('whatsapp: webhook parsing', () => {
  const envelope = (message: unknown, contacts?: unknown) =>
    ({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { contacts, messages: [message] } }] }],
    }) as WaPayload;

  it('reads a plain message, with the sender’s profile name', () => {
    const parsed = parseUpdate(
      envelope(
        { id: 'wamid.1', from: '15550001111', type: 'text', text: { body: 'buy milk' } },
        [{ wa_id: '15550001111', profile: { name: 'Preethi' } }],
      ),
    );
    assert.equal(parsed?.message?.text, 'buy milk');
    assert.equal(parsed?.message?.userDisplayName, 'Preethi');
    assert.equal(parsed?.message?.chatType, 'dm');
    assert.equal(parsed?.message?.addressedToBot, true);
  });

  it('reads a reply-button tap and a list tap the same way', () => {
    const wire = encodeAction({ kind: 'task_done', taskId: 'tsk_1' });
    for (const interactive of [
      { type: 'button_reply', button_reply: { id: wire, title: '✓' } },
      { type: 'list_reply', list_reply: { id: wire, title: '✓' } },
    ]) {
      const parsed = parseUpdate(
        envelope({ id: 'wamid.2', from: '15550001111', type: 'interactive', interactive }),
      );
      assert.deepEqual(parsed?.action?.action, { kind: 'task_done', taskId: 'tsk_1' });
      assert.equal(parsed?.action?.ackToken, 'wamid.2');
    }
  });

  it('reads a template quick-reply, which is how the nudge gets answered', () => {
    const parsed = parseUpdate(
      envelope({
        id: 'wamid.3',
        from: '15550001111',
        type: 'button',
        button: { payload: encodeAction({ kind: 'digest_show' }), text: 'Show me' },
      }),
    );
    assert.deepEqual(parsed?.action?.action, { kind: 'digest_show' });
  });

  it('ignores delivery receipts instead of treating them as messages', () => {
    const parsed = parseUpdate({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { statuses: [{ status: 'delivered' }] } }] }],
    });
    assert.equal(parsed, null);
  });

  it('accepts media without crashing and without acting on it', () => {
    const parsed = parseUpdate(
      envelope({ id: 'wamid.4', from: '15550001111', type: 'image', image: { id: 'x' } }),
    );
    assert.equal(parsed?.updateId, 'wamid.4');
    assert.equal(parsed?.message, undefined);
    assert.equal(parsed?.action, undefined);
  });

  it('survives an empty or malformed payload', () => {
    assert.equal(parseUpdate({}), null);
    assert.equal(parseUpdate({ entry: [] }), null);
    assert.equal(parseUpdate({ entry: [{ changes: [{ value: {} }] }] }), null);
  });
});

describe('whatsapp: webhook security', () => {
  const secret = 'app-secret';
  const body = '{"object":"whatsapp_business_account"}';

  async function sign(payload: string, key: string) {
    const k = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(payload));
    return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  it('accepts a correctly signed body', async () => {
    assert.equal(await verifySignature(body, await sign(body, secret), secret), true);
  });

  it('rejects a body signed with the wrong secret, a tampered body, and no header', async () => {
    assert.equal(await verifySignature(body, await sign(body, 'wrong'), secret), false);
    assert.equal(await verifySignature(`${body} `, await sign(body, secret), secret), false);
    assert.equal(await verifySignature(body, null, secret), false);
    assert.equal(await verifySignature(body, 'garbage', secret), false);
    // An unset secret must never be a way in. (Signing with an empty key is
    // not even expressible -- WebCrypto refuses it -- which is why the
    // adapter checks for it before it gets that far.)
    assert.equal(await verifySignature(body, await sign(body, secret), ''), false);
  });

  it('completes the subscription handshake only with the right verify token', () => {
    const url = (token: string) =>
      new URL(`https://x/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`);
    assert.equal(verifySubscription(url('good'), 'good'), '42');
    assert.equal(verifySubscription(url('bad'), 'good'), null);
    assert.equal(verifySubscription(url('good'), ''), null);
    assert.equal(
      verifySubscription(new URL('https://x/whatsapp/webhook?hub.mode=subscribe'), 'good'),
      null,
    );
  });
});

describe('whatsapp: end to end through the engine', () => {
  let db: Awaited<ReturnType<typeof stage>>['db'];

  async function stage() {
    const { db } = memoryDb();
    const family = await ensureFamily(db, 'Home');
    const preethi = await addMember(db, {
      familyId: family.id,
      name: 'Preethi',
      channel: 'whatsapp',
      channelUserId: '15550001111',
      channelChatId: '15550001111',
    });
    const home = await resolveList(db, family.id, null);
    const task = await createTask(db, {
      familyId: family.id,
      listId: home.id,
      title: 'Fix the kitchen leak',
      createdBy: preethi.id,
      assigneeKind: 'member',
      assignedTo: preethi.id,
    });
    const { api, sent } = fakeApi();
    const channel = whatsAppChannel(api);
    const deps: AppDeps = { db, channel, channels: { whatsapp: channel }, anthropic: null };
    return { db, family, preethi, home, task, deps, sent };
  }

  it('answers a command on the channel it arrived on', async () => {
    const st = await stage();
    const parsed = parseUpdate({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ profile: { name: 'Preethi' } }],
                messages: [
                  { id: 'wamid.1', from: '15550001111', type: 'text', text: { body: '/tasks' } },
                ],
              },
            },
          ],
        },
      ],
    } as WaPayload);
    await handleInboundMessage(st.deps, parsed!.message!);
    const body = JSON.stringify(st.sent);
    assert.match(body, /Fix the kitchen leak/);
  });

  it('folds the toast into the message, since there is nowhere ephemeral to put it', async () => {
    const st = await stage();
    const board = renderTaskList('Your tasks', [await getTaskView(st.db, st.task.id)]);
    await rememberView(st.db, '15550001111', 'wamid.0', board.view!);

    const tap = {
      chatId: '15550001111',
      chatType: 'dm' as const,
      userId: '15550001111',
      userDisplayName: 'Preethi',
      messageId: 'wamid.0',
      ackToken: 'wamid.0',
    };
    await handleInboundAction(st.deps, { ...tap, action: { kind: 'task_done', taskId: st.task.id } });
    await handleInboundAction(st.deps, {
      ...tap,
      action: { kind: 'task_done_confirm', taskId: st.task.id },
    });

    assert.equal((await getTaskView(st.db, st.task.id)).state, 'done');
    const said = JSON.stringify(st.sent);
    assert.match(said, /Done: Fix the kitchen leak/, 'the confirmation is not silently dropped');
    assert.ok(st.sent.some((b: any) => b.status === 'read'), 'and the tap is acknowledged');
  });

  it('reports a rejected tap in a message rather than losing it to a toast', async () => {
    const st = await stage();
    // Claimed by somebody else, so the tap must fail with a UserError.
    const other = await addMember(st.db, {
      familyId: st.family.id,
      name: 'Arjun',
      channel: 'telegram',
      channelUserId: '1001',
      channelChatId: '1001',
    });
    const contested = await createTask(st.db, {
      familyId: st.family.id,
      listId: st.home.id,
      title: 'Take the bins out',
      createdBy: other.id,
      assigneeKind: 'member',
      assignedTo: other.id,
    });
    await handleInboundAction(st.deps, {
      chatId: '15550001111',
      chatType: 'dm',
      userId: '15550001111',
      userDisplayName: 'Preethi',
      messageId: 'wamid.0',
      ackToken: 'wamid.0',
      action: { kind: 'task_claim', taskId: contested.id },
    });
    assert.match(JSON.stringify(st.sent), /already claimed/);
  });
});

describe('whatsapp: text splitting', () => {
  it('splits on a newline near the limit and keeps everything', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const chunks = splitForWhatsApp(text, 400);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 400));
    assert.equal(chunks.join('\n'), text);
  });
});
