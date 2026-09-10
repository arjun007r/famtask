# Architecture

Family task management over Telegram. One family, many lists, tasks that
bounce between people, and a daily digest that tells each person what to do
next.

Confirmed with the owner before implementation: task states (five plus
`cancelled`), the 3-list digest cap, group tasks surfacing in both the group
chat and personal digests, and Cloudflare as the host.

## Layers

```
  Telegram  ──▶ src/telegram/         wire format, inline keyboards, callback_data
                     │                (the only files that know Telegram exists)
                     ▼
                src/channel/          MessagingChannel interface + neutral
                     │                RenderedMessage/Action types
                     ▼
                src/app.ts            composition root: routing, commands,
                     │                digest sweep. Drives everything below.
        ┌────────────┴────────────┐
        ▼                         ▼
   src/agents/               src/core/          engine: schema, state machine,
   parser.ts                 services/*         ranking, lists, digests.
   digest-writer.ts          db/adapter.ts      Knows nothing about Telegram
                                                or Claude.
```

Swapping Telegram for another channel means writing a new `src/telegram/`
equivalent and a new entrypoint. Nothing in `src/core/` changes.

`src/core/services/inbox.ts` and `queries.ts` import types from
`src/agents/` and `src/channel/` — type-only imports, no runtime dependency.
They produce `RenderedMessage`, which is the channel-neutral interface, not a
Telegram type.

**Messages are plain text, no markup.** Every channel renders emphasis
differently and Telegram's MarkdownV2 escaping is a reliable source of
500s. Structure comes from line breaks, numbering, and a few state glyphs.

## Data model

SQLite dialect throughout — D1 in production, `node:sqlite` for tests and the
CLI, behind the same `Db` interface (`src/core/db/adapter.ts`). Ids are
prefixed uuids (`tsk_…`, `mem_…`), timestamps are ISO-8601 UTC strings.

| Table | Purpose |
|---|---|
| `families` | The workspace. One row today. Holds `group_chat_id`. |
| `family_members` | Registry: name, `telegram_user_id`, DM chat id, timezone, digest hour. |
| `lists` | Named lists. `owner_member_id NULL` = shared with the family. |
| `member_digest_lists` | Each person's pick of ≤3 lists for their daily digest. |
| `tasks` | The task itself, incl. `family_id`, `list_id`, state, priority, `source_chat_id`/`source_message_id`. |
| `task_events` | Thread history and audit trail in one stream: `created`, `comment`, `state_change`, `reassigned`, `priority_change`, `edited`. |
| `digest_sends` | One row per (member, task, day) appearance. Drives digest rotation. |
| `processed_updates` | Telegram redelivers on non-200; this makes retries no-ops. |
| `app_state` | Scheduler bookkeeping (e.g. "group board already posted today"). |

Two invariants enforced in SQL rather than trusted to callers:
`assignee_kind = 'member'` iff `assigned_to IS NOT NULL`, and `state` /
`priority` are CHECK-constrained enums.

`family_id` is on tasks, lists, and members. It is always one value today.
It exists so a second family is a migration-free change; nothing else in the
codebase concedes anything to multi-tenancy.

## State machine

`src/core/state-machine.ts`.

```
        ┌──────────────────────────────────────────┐
        ▼                                          │
      todo ──▶ in_progress ──▶ blocked ────────────┤
        │           ▲    │         ▲               │
        │           │    │         ▼               │
        │           │    └▶ needs_clarification ───┤
        │           │                              │
        ▼           ▼                              │
      done ◀────────┴──────────────────────────────┘
        │
        └──▶ todo | in_progress   (reopen)

      cancelled: reachable from any open state; reopens to todo/in_progress.
```

`blocked` and `needs_clarification` are first-class because tasks bounce —
the whole point of the app. `done` and `cancelled` are closed (excluded from
digests and "my tasks") but reopenable, so nothing is ever truly stuck.
`done → blocked` is rejected; reopen first.

## Priority and ranking

`src/core/priority.ts` computes a deterministic score: explicit priority
dominates, then due date (overdue > today > 2 days > a week), then age, then
a small bump for states that are waiting on a human (`needs_clarification` >
`blocked` > `in_progress`).

Tasks already shown in past digests are penalised by `12 × min(timesShown, 5)`
— enough that the next digest surfaces the next batch, not enough for a
high-priority task to sink below a low-priority one. Nothing ever silently
falls off the list.

## Lists and the digest

- A task belongs to exactly one list. Any member can create one; an unknown
  list name in a captured message creates it rather than dropping the task.
- Lists are shared (`owner_member_id NULL`) or personal to one member.
- **≤3 visible lists**: all feed the daily digest, no setting needed.
- **>3**: the member picks 3 via `/digestlists`. Until they pick, the three
  lists with the most open tasks are used and the digest says so.
- Lists outside the pick stay fully usable on demand (`/list <name>`, "show
  my business list"); they are just not pushed daily.

## Notifications

The digest is a daily push, but a task assigned to you at 2pm should not wait
until 9am tomorrow. `applyParsed` returns an `InboxResult` of
`{ reply, notify }`: the reply goes back to the chat the message came from,
and `notify` carries DMs for people who are not reading it —

- the assignee, when a task is created for them or passed to them;
- the person who raised a task, when someone else moves or comments on it.

Nobody is notified about their own action, and anyone whose DM chat the bot
has not seen yet is skipped rather than failing the whole update.

A digest is the member's top 5 incomplete tasks across their digest lists,
labelled by list, with one-tap ✓/▶ buttons — plus up to 3 unclaimed
group tasks with Claim buttons. Unclaimed work is also posted once a day to
the family group chat, so it is visible in both places until someone takes it.

## Scheduling

One hourly Cron Trigger. `membersDueNow()` compares each member's local hour
(via `Intl.DateTimeFormat` in their own timezone) against their `digest_hour`,
so per-person send times and timezones work off a single trigger. The group
board is posted once per day, guarded by `claimOnce()` against `app_state`.

## The two agents

Deliberately separate modules with separate prompts and schemas.

**`src/agents/parser.ts`** — classify one chat message as `new_task`,
`status_update`, `reassignment`, `clarification`, `comment`, `query`, or
`chitchat`, and extract structured fields. It never touches the database;
`src/core/services/inbox.ts` decides what to do with the result, which makes
the whole path testable against hand-written fixtures. Confidence floor is
0.5 in DMs and 0.65 in the group — a missed task is recoverable, a chat log
full of junk tasks is not.

**`src/agents/digest-writer.ts`** — reorder within an already-ranked
candidate set and write one intro line. Its output is sanitised: ids it
invented are dropped, ids it omitted are appended. An API outage degrades the
digest's tone, never its contents.

Both use strict-schema tool calls with `tool_choice: auto` (the system prompt
names the tool), which keeps them compatible with adaptive thinking. Model
defaults to `claude-opus-5`, overridable via the `CLAUDE_MODEL` var.

### When the agent is unavailable

`structuredCall` throws `AgentUnavailableError` when the API cannot be
reached at all — no credit, bad key, rate limit, upstream down — as distinct
from returning null, which means the model ran and had nothing to say.
Callers must not let it propagate: a retry cannot fix billing, and throwing
out of the webhook handler makes Telegram redeliver the same update forever.

- **Inbound message**: caught in `app.ts`. A DM gets one plain sentence
  naming the cause; the group stays silent rather than showing the family a
  billing error. Slash commands keep working throughout.
- **Digest**: the deterministic ranking already stands alone, so the digest
  is sent in ranked order minus the intro line.

The cause is classified on `status` and message text, not `instanceof` — the
billing failure is a 400 with no error class of its own, and `instanceof`
stops matching if two copies of the SDK end up in the tree.

Matching an update to an existing task is *not* a model call — it is
deterministic word overlap in `inbox.ts:matchTask`. The agent already named
its target; a second model call would be slower and no more reliable on
three-word titles.

## Cost control

Every group message would otherwise cost an API call. `looksActionable()` in
`app.ts` is a keyword prefilter that lets addressed messages and plausible
asks through and drops idle chatter. DMs are always parsed.

## Open decisions

- **Group prefilter tuning.** `looksActionable()` is keyword-based and will
  miss phrasings. Worth reviewing against a week of real messages before
  making it stricter or looser.
- **Digest rotation.** The `timesShown` penalty is a guess at the right feel.
  If a stale task keeps reappearing, raise the coefficient; if things vanish
  too fast, lower it.
- **Reopening a `done` task from a button.** Currently only possible by
  message. Fine for now.
- **`task_events` growth.** Unbounded. Irrelevant at family scale; would need
  pruning if this ever grew.
- **No per-member permissions.** Any member can act on any task in a list
  they can see. Intentional for a family.
