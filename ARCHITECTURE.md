# Architecture

Family task management over Telegram. One family, many lists, tasks that
bounce between people, and a daily digest that tells each person what to do
next.

Confirmed with the owner before implementation: task states (five plus
`cancelled`), the 3-list digest cap, group tasks surfacing in both the group
chat and personal digests, and Cloudflare as the host.

## How it runs

Four flows. The first two happen when you change something; the last two are
the app actually working.

### 1. Deploy — your laptop to Cloudflare

```
  npm run deploy
       │   bundles src/worker.ts and everything it imports
       ▼
  wrangler ──────────────▶  Cloudflare edge
                              ├── Worker   famtask
                              ├── D1       famtask      (bound as env.DB)
                              ├── Secrets  bot token, webhook secret, API key
                              └── Cron     0 * * * *
```

Nothing of yours is running between deploys. The Worker is cold code that
Cloudflare executes when a request or the cron wakes it.

### 2. Register the webhook — once, not on every deploy

```
  node scripts/set-webhook.mjs <url>
       │
       ▼
  Telegram Bot API  ·  setWebhook
       "send this bot's updates to
        https://famtask.famtask.workers.dev/telegram/webhook,
        and stamp each one with secret token S"
```

BotFather created the bot and issued the token. It did **not** create the
webhook — this call did, and it only needs repeating if the URL changes.
Telegram then pushes updates; the Worker never polls.

### 3. A message arrives

```
  You ──▶ Telegram ──── POST /telegram/webhook ────▶ Worker
                                                       │
   1. secret header matches?              no ──▶ 403 ──┤
   2. update_id already seen?      (D1)  yes ──▶ 200 ──┤
   3. known family member?         (D1)   no ──▶ ask ──┤
   4. starts with "/"?                   yes ──▶ run ──┤
   5. free text ──▶ Claude · parser agent              │
                     intent + fields                   │
   6. apply to the engine          (D1)                 │
                                                       ▼
  You ◀── Telegram ◀──── sendMessage ◀──── reply + buttons
```

Steps 1 and 2 are why a retry or a stray internet request costs nothing.
Step 4 is why slash commands never spend an API call.

### 4. The daily digest

```
  Cloudflare Cron  ·  hourly
       │
       ▼
  Worker  scheduled()
       │  who has reached their digest hour?   (D1, per-member timezone)
       │  their top 5 + unclaimed work         (D1, deterministic ranking)
       │  opening line                         (Claude · digest agent)
       ▼
  Telegram sendMessage ──▶ each due person's DM
```

The cron fires 24 times a day and usually sends nothing — it is the
per-member timezone check, not the schedule, that decides who gets a digest.
That is how one trigger serves different people at different local times.

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

**Every task line ends with who holds it.** No exceptions, including a
person's own digest. Suppressing the name there because "they are all yours
anyway" is the author's logic, not the reader's — it makes someone work out
a rule to answer the first question a family asks. Group and unassigned work
is marked in the same position.

The **list** tag is the opposite case and does appear conditionally: only
when more than one list is on screen. Printed on every row of a
single-list family it said nothing and sat exactly where an assignee would,
which is how it came to be read as one.

**Messages are plain text, no markup.** Every channel renders emphasis
differently and Telegram's MarkdownV2 escaping is a reliable source of
500s. Structure comes from line breaks, numbering, and a few state glyphs.

## Data model

SQLite dialect throughout — D1 in production, `node:sqlite` for tests and the
CLI, behind the same `Db` interface (`src/core/db/adapter.ts`). Ids are
prefixed uuids (`tsk_…`, `mem_…`), timestamps are ISO-8601 UTC strings.

| Table | Purpose |
|---|---|
| `families` | The workspace. One row today. Holds `group_chat_id` + `group_chat_channel`. |
| `family_members` | Registry: name, `channel` + `channel_user_id`, DM chat id, timezone, digest hour. |
| `lists` | Named lists. `owner_member_id NULL` = shared with the family. |
| `member_digest_lists` | Each person's pick of ≤3 lists for their daily digest. |
| `tasks` | The task itself, incl. `family_id`, `list_id`, state, priority, `waiting_on`, `source_chat_id`/`source_message_id`. |
| `task_events` | Thread history and audit trail in one stream: `created`, `comment`, `state_change`, `reassigned`, `priority_change`, `edited`. |
| `digest_sends` | One row per (member, task, day) appearance. Drives digest rotation. |
| `processed_updates` | Telegram redelivers on non-200; this makes retries no-ops. |
| `app_state` | Scheduler bookkeeping, plus what each sent message is showing (see Views). |

Two invariants enforced in SQL rather than trusted to callers:
`assignee_kind = 'member'` iff `assigned_to IS NOT NULL`, and `state` /
`priority` are CHECK-constrained enums.

`family_id` is on tasks, lists, and members. It is always one value today.
It exists so a second family is a migration-free change; nothing else in the
codebase concedes anything to multi-tenancy.

## One family, more than one messaging app

Two people in a household can refuse to share an app and still share a task
list. `family_members.channel` names which one reaches each person; ids are
only unique within a channel, so `(channel, channel_user_id)` is the key.

`AppDeps` carries both `channel` — the one the current update arrived on, and
the default for every reply — and `channels`, a map of every adapter this
deployment has. A reply needs only the first. A digest run needs the second:
one cron tick has to reach everybody, long after the inbound channel stopped
being relevant. `addressOf(member)` returns the `(channel, chatId)` pair and
`sendMessage()` routes on it.

A member whose channel has no adapter wired up is **skipped with a log line**,
never a thrown error. Mid-rollout, half the family working is the correct
behaviour; a cron that dies because one adapter is missing is not.

Adding an app is `src/<app>/` implementing `MessagingChannel`, plus one line
in `buildChannels()`. Nothing above the channel boundary changes — which is
what that boundary was for.

`/adduser <channel>:<id> <name>` is how somebody on one app adds somebody on
another; a bare id keeps the adder's channel. Adding a member on a channel
with no adapter is allowed and says so, because the member usually exists
before the adapter does.

**Members with no device.** `channel = 'offline'` is a member who owns tasks
and is named on them like anyone else but cannot be messaged: a young kid, a
grandparent. `channel_chat_id` stays NULL, which the digest and notification
paths already read as "unreachable, skip".

Skipping them silently was the bug — their tasks then appeared in *nobody's*
digest. `guardian_member_id` is the family member who carries that work:
their dependents' open tasks are ranked in alongside their own, so a kid's
homework due today outranks a parent's chore due next month. The task line
already names the owner, so nothing is ambiguous about whose it is.

**One member, one channel.** Nothing stops two rows sharing a name on
different channels, but the engine would treat them as two people with
separate task ownership. If that is ever wanted it should be a
`member_identities` table, not a convention.

**One group chat, on one channel.** `group_chat_channel` records which, so
routing is explicit rather than inherited from whichever adapter the cron was
built with. It is deliberately not one group per channel: WhatsApp's Groups
API requires an Official Business Account, which a household will not have.
Members on a channel with no group still get unclaimed work in the "Up for
grabs" tail of their own digest, which is the part that actually matters.

Channels differ in what they can do, and the interface says so rather than
pretending otherwise. Three optional members carry it, and the engine reads
capabilities, never channel names:

| | meaning | WhatsApp |
|---|---|---|
| `update?` | can edit a sent message | absent — no edit endpoint exists |
| `toasts?` | has an ephemeral acknowledgement | `false` |
| `fallback` on a message | what to send if the real one is refused | the template nudge |

A channel that cannot edit falls back to posting a fresh message, with the
recorded view attached to the new id so its buttons still work. A channel with
no toasts gets the same words folded into the redraw instead — a tap is never
silently swallowed. A channel with no buttons ignores `buttons` entirely.

### WhatsApp

`src/whatsapp/`. Three things differ from Telegram and are absorbed in the
adapter:

**Buttons.** Three reply buttons, or a ten-row list, against Telegram's
effectively unlimited keyboard. `collapse()` flattens the keyboard
**column-major**: every row's first button before any row's second. The
renderer already puts the action people want first in each row, so a full
digest keeps one tap available for every task rather than spending all ten
slots on menus for the first five.

**No editing.** `update` is deliberately not implemented rather than faked by
sending a new message — faking it would leave the recorded view pinned to the
old message id, and the buttons on the new one would have no view to unwind.

**The 24-hour window.** Outside it, only a pre-approved template gets through,
and template parameters reject newlines — so a task list can never be one.
Rather than track the window and drift, the adapter sends the real message and
treats error `131047` as the instruction it is: retry as the `fallback`
template, a short nudge whose quick-reply button carries a `digest_show`
action. Tapping it is an inbound message, which reopens the window, and the
engine answers with the real digest.

A member whose digest fails to send is logged and skipped; one unreachable
person never costs the rest of the family their morning.

## Waiting on someone outside the family

A large share of household admin is not work the family does — it is work the
family *chases*: the plumber, the school office, an insurer, a relative. Those
tasks are the ones that get dropped, because there is no shared channel with
the person who actually has to act.

`tasks.waiting_on` is free text naming that outside party. It is deliberately
**not** an assignee:

- `assigned_to` still names a family member — whoever is chasing it. A task
  with no family member on it reaches nobody's digest and rots, which is the
  one failure this app exists to prevent. When a message names only an
  outsider, the person who raised it becomes the chaser.
- Chasing is optional in the sense the family means it: the task can sit with
  the group or unassigned, in which case it surfaces under "Up for grabs"
  rather than in one person's list. What it cannot do is belong to nobody at
  all.
- It is orthogonal to `state`. "Ring the plumber on Thursday" is `todo` and
  waiting; "can't start until the plumber quotes" is `blocked` and waiting.
  Collapsing the two would lose one of them.

No contacts table, no reminders sent outward, no integration. A name is a
string. The moment an outsider gets a record, a family task list is a CRM.

`/waiting` lists it — GTD's "waiting for" list, which is where the idea comes
from. The parser has a matching `waiting` query scope, so "what are we waiting
on other people for?" works in plain words.

**The guard.** An agent that hears "Preethi is chasing the school" can as
easily put *Preethi* in `waiting_on`, which would hide a real assignment
behind free text. `resolveWaitingOn()` drops any value that matches a family
member or a stand-in for the group, so assignment resolution always wins.
The eval suite covers both directions.

Setting a wait needs free text, so it happens by message. Ending one is a
button — `✅ <name> came back` appears on the `⋯` menu only when there is a
wait to end.

## Finished work

Open tasks are the product; finished ones are the evidence it worked.
`/done [week|month|quarter|year]` answers from `tasks.closed_at`, newest
first, with a count in the heading. The parser has a matching `completed`
scope and reads the period from the words used, so "what did we get done this
month" works.

Windows are **rolling days**, not calendar boundaries — in a family chat "the
past month" means the last thirty days, not since the 1st. A closed task
renders with `✓` and offers only `⋯`: there is nothing left to finish, but its
history is still worth reaching.

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

## Due dates, urgency and ownership

`due_at` drives urgency, and both derived values come from it rather than
being stored:

- `timingOf()` → `overdue` | `due-soon` (within 2 days) | `upcoming` | `none`
- `effectivePriority()` → `high` whenever timing is overdue or due-soon,
  otherwise the stored priority

Nothing sweeps a flag and nothing goes stale, and moving the deadline out
de-escalates the task by itself — which is the whole recovery path for an
overdue item. Messages move deadlines through the parser's `new_due_date`
("push the HVAC one to the 30th"), so it works from a phone without a
command. Closed tasks have no timing.

Calendar days are compared in UTC, not timestamps: a task due at midnight
today must not read as overdue by mid-morning.

**A task with no named owner belongs to whoever raised it.** Unassigned
reads as a fault to the person who just wrote it down, and someone has to
hold a task until it is explicitly handed over or thrown open with
"group"/"anyone". Only an explicit hand-off produces a group or unassigned
task.

`created_by` and `created_at` — the reporter and when they raised it — are
shown on the task detail card.

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
labelled by list — plus up to 3 unclaimed group tasks. Unclaimed work is also
posted once a day to the family group chat, so it is visible in both places
until someone takes it.

## Buttons

Every task listing — digest, group board, `/tasks` — is rendered by one
function, `renderBoard()`.

**Buttons refer to the numbers already on screen**, four to a row:

```
1. ○ !! Schedule roof cleaning for Puyallup home (OVERDUE — was due 2026-09-15) — Arjun
2. ○ Upload docs for Ownwell (due 2026-09-30) — Arjun
...
✓ done · ⋯ more

[ ✓ 1 ][ ✓ 2 ][ ✓ 3 ][ ✓ 4 ]
[ ✓ 5 ][ ✓ 6 ][ ✓ 7 ]
[ ⋯ 1 ][ ⋯ 2 ][ ⋯ 3 ][ ⋯ 4 ]
[ ⋯ 5 ][ ⋯ 6 ][ ⋯ 7 ]
```

Labelling each button with its task's title was the obvious first design and
the wrong one: at Telegram's width a title truncates to `✓ Schedule roof
cleanin…`, which is unreadable, and seven of them stacked under the list
doubles the height of the message to repeat what it already says. Numbers
cost one legend line and nothing else.

Tasks and unclaimed work share **one run of numbers**, so `3` means the third
line whichever section it is in. `⋯` opens a task's full action set: Start,
Blocked, Needs info, Reassign, Details.

`Button.primary` marks the action someone came for (`✓`, `🙋`) rather than a
way into more options. Channels with room render everything; WhatsApp, capped
at ten, keeps the primaries — so what gets dropped is a second way into a
task, never the only way into one.

`✓` does not finish anything. It opens a confirmation, because a mis-tap in
front of the family is awkward to walk back. Every other action applies
immediately.

### Views

A tap arrives carrying a message id and nothing else, so the engine records
what each message is showing when it sends it — a `View`, in
`src/core/services/views.ts`, kept in `app_state` under `view:<chat>:<message>`.
On every tap the engine replays that view against live rows and edits the
message in place. Two things follow:

- The screen changes the moment you tap. A finished task ticks over to `✓`
  where it sits; a claimed task moves out of "up for grabs" into the numbered
  list. A toast alone is not feedback — it disappears.
- Overlays (menu, confirm, reassign, detail) nest the view they cover, so
  Back and Cancel restore exactly what was underneath, and applying an action
  returns to the listing rather than to a menu for a task that is now done.

Views are swept after three days on the scheduled run; Telegram refuses to
edit a message older than 48 hours anyway. A tap on a message with no
recorded view still works — it applies and replies with a fresh message.

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

### Never silent in a DM

A DM to a task bot is almost always meant as a task, so saying nothing reads
as a fault — and during setup it is genuinely indistinguishable from one. So
every DM gets an answer, including when the engine deliberately does
nothing: chit-chat, a confidence score below the floor, or a model reply
that skipped the tool call each produce a short explanation naming the
reason. The parsed intent and confidence are logged on every message, so
`wrangler tail` shows why.

In the group the opposite holds: staying quiet on chit-chat is the entire
point, so nothing is sent there.

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

## Mirroring out

`src/sync/` is a second boundary, shaped like the channel one: `SyncTarget`
is the interface, `todoist.ts` the only implementation, and `core/services/
sync.ts` decides *what* to push without knowing where it goes.

The push is a **reconcile, not a fire-on-write**. Each task's mirrored shape
is hashed and stored next to its external id, so a sweep skips everything
unchanged in one query. That has two consequences worth keeping: it is cheap
enough to run after every message *and* on the cron, and a failed push heals
on the next pass, because only a successful one records its hash.

One-way, deliberately. famtask owns the state; the target is an audience.
Syncing back would need conflict rules for two writers over one row, and the
value here is that the rest of the family can *see* tasks in an app they
already have — not that they can edit them there.

Todoist rather than Google Tasks: Google Tasks lists cannot be shared with
another person, so a family would each see only their own, and it needs
per-user OAuth. Todoist has shared projects and a personal API token.

## Cost control

Calls avoided entirely:

- **Slash commands** are handled before the agent is ever constructed.
- **Group chatter** is dropped by `looksActionable()` in `app.ts`, a keyword
  prefilter — without it every idle group message costs a call. Addressed
  messages always pass. DMs are always parsed, since a DM to a task bot is
  almost always meant as one.
- **Task matching** is word overlap, not a second model call.
- **Digest ranking** is deterministic; the agent only reorders within the
  already-chosen five and writes one line, and the digest still sends if it
  fails.

That leaves roughly one call per free-text DM and per actionable group
message, plus one per person per day for the digest.

**Model choice is a config change, not a code change:** the `CLAUDE_MODEL`
var. Parsing is closed-set classification with a strict schema, which is the
shape a smaller model handles well — so measure before paying for a larger
one:

```bash
npm run eval -- --model claude-haiku-4-5
```

Compare against `evals/baseline.json`. Note that `output_config.effort` is
rejected by Haiku 4.5 and Sonnet 4.5; `supportsEffort()` omits it for those,
so swapping the model does not 400.

Measured once already: Haiku 4.5 matched Opus 5 on intent accuracy (1.0) and
on chit-chat false positives (0.0), with one real field miss each, at a
fifth of the price. Relative dates are where a smaller model is most likely
to differ — if that starts to matter, resolving "friday" and "next monday"
in code rather than in the prompt removes the hardest part of the job from
the model entirely, and would help whichever model is in use.

## Moving to another account

Nothing here is tied to the personal accounts it was first set up under.
Roughly in order of how much work each piece is.

**GitHub — minutes.** Settings → Transfer ownership moves the repo to an
org, keeping history, issues and redirects from the old URL. Or just
`git remote set-url` and push; the history is portable either way.

**Anthropic — minutes.** Issue a key in the new org and swap it:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Credit balances do *not* transfer between accounts, so avoid preloading a
large balance on an account you expect to move off.

**Cloudflare — under an hour.** There is no account transfer for Workers,
and none is needed: the Worker is this repo plus config. Sign in as the new
account and redeploy. The only real work is the data.

```bash
# from the old account
npx wrangler d1 export famtask --remote --output famtask-backup.sql

# then, signed in as the new account
npx wrangler login
npx wrangler d1 create famtask          # put the new id in wrangler.toml
npx wrangler d1 execute famtask --remote --file=famtask-backup.sql
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
node scripts/set-webhook.mjs <new worker url>    # with the same env vars
```

The export is worth running periodically regardless — it is the only backup
of the family's tasks.

**Telegram — the one thing that cannot be transferred.** A BotFather bot
belongs to the Telegram *user account* that created it, not to an email, and
there is no hand-off between accounts. A differently-owned bot means a new
bot, a new token and a new @username.

That is cheaper than it sounds, because of how Telegram ids work. For a
direct message `chat_id` *is* the user's id, and `telegram_user_id` does not
change, so the existing `family_members` rows stay valid against a new bot.
Group chat ids are properties of the group, not the bot, so `group_chat_id`
survives too. The only manual step is that each member must `/start` the new
bot once — a bot cannot message someone who has never opened a conversation
with it — and the bot must be re-added to the family group.

**What makes all of this cheap** is already in place and worth not undoing:
`family_id` on tasks, lists and members; the `Db` interface, so Postgres
instead of D1 is an adapter rather than a rewrite; and secrets that have
never lived in the repo, so there is nothing personal baked into what gets
transferred.

## Open decisions

- **Group prefilter tuning.** `looksActionable()` is keyword-based and will
  miss phrasings. Worth reviewing against a week of real messages before
  making it stricter or looser.
- **Digest rotation.** The `timesShown` penalty is a guess at the right feel.
  If a stale task keeps reappearing, raise the coefficient; if things vanish
  too fast, lower it.
- **Reopening a `done` task from a button.** A finished task keeps its line
  and offers Details, but reopening it still takes a message. Fine for now.
- **`task_events` growth.** Unbounded. Irrelevant at family scale; would need
  pruning if this ever grew.
- **No per-member permissions.** Any member can act on any task in a list
  they can see. Intentional for a family.
- **Waiting tasks rank like any other.** A task parked on a contractor is not
  actionable today, so it arguably belongs below one that is. Ranking was left
  alone rather than guessed at; revisit once `/waiting` has a few weeks of use.
