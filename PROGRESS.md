# Progress

## Built

- **Deploy on push** (`.github/workflows/deploy.yml`) — typecheck, tests,
  migrations, deploy, health check, in that order. The two steps easiest to
  forget by hand cannot be forgotten here.

- **Schema** (`migrations/`) — families, members, lists, per-member digest
  list picks, tasks, task events (thread + audit), digest sends, update
  dedupe, scheduler state. Runs on D1 and `node:sqlite` unchanged.
- **Engine** (`src/core/`) — state machine with the six confirmed states,
  deterministic priority ranking with digest-rotation penalty, task CRUD +
  claim/assign/comment, list resolution and the ≤3 digest-list rule,
  digest assembly, on-demand queries.
- **Agents** (`src/agents/`) — message parser (classify + extract) and
  digest writer (reorder + intro), separate modules, strict-schema tool
  calls, output sanitised before use.
- **Channel boundary** (`src/channel/`) — `MessagingChannel`, structured
  `Action`s, plain-text `RenderedMessage` rendering. No Telegram types.
- **Telegram layer** (`src/telegram/`) — Bot API client, update parser
  (DMs, groups, callbacks, being added to a group), callback_data codec
  within the 64-byte cap, message splitting at 4096 chars.
- **Orchestration** (`src/app.ts`) — routing, all slash commands, digest
  sweep with per-person timezones, group board posting, bootstrap flow.
- **Worker** (`src/worker.ts`) — webhook with secret-token check, update
  dedupe with rollback on failure, hourly cron.
- **CLI** (`src/cli.ts`) — drives the same `app.ts` with a console channel.
- **Due dates drive urgency** — `overdue` / `due-soon` and the priority bump
  are derived from `due_at`, never stored, so moving a deadline out
  de-escalates by itself. Deadlines move by message.
- **`/all`** — every open task in the family, whoever owns it.
- **One-way Todoist mirror** (`src/sync/`) — off unless `TODOIST_TOKEN` is
  set. A reconcile, not a fire-on-write, so a failed push heals on the next
  pass. Chosen over Google Tasks, whose lists cannot be shared.
- **Finished-work history** — `/done [week|month|quarter|year]`, plus a
  `completed` parser scope so plain questions work. Rolling days, newest first.
- **Several tasks from one message** — the agent splits a sentence into as many
  tasks as it holds, each keeping its own owner; `/add` splits on newlines and
  semicolons, never on "and".
- **Interactive buttons** (`src/core/services/views.ts`) — listings are numbered and the
  keyboard refers to those numbers four to a row, rather than repeating
  truncated titles one per line. `⋯` opens Start / Blocked / Needs info /
  Reassign / Details. `✓` asks for confirmation first. Taps edit the message
  in place, so the screen reflects the change immediately, and Back restores
  what an overlay covered.
- **Members with no device** — `channel = 'offline'` plus a guardian whose
  digest carries their work. A kid can own tasks without owning a phone.
- **WhatsApp** (`src/whatsapp/`) — Cloud API adapter: signed webhook, reply
  buttons and list messages within Meta's caps, and a template fallback so the
  daily digest survives the 24-hour window. Tested against a fake API; never
  run against Meta.
- **Per-member channels** — `family_members.channel` routes each person to the
  app that reaches them, so a family split across Telegram and WhatsApp still
  shares one task list. One cron tick fans a digest out across all of them.
  Only a channel adapter is missing for any new app.
- **Waiting on outsiders** (`tasks.waiting_on`, `/waiting`) — work the family
  can only chase: contractors, offices, relatives. A family member still owns
  the chasing, so it never falls out of a digest. Free text by design; a guard
  keeps family members out of the field.
- **Notifications** — assignment, reassignment, status changes and comments
  DM the other party immediately; the daily digest is the backstop, not the
  only channel.
- **Task detail view** — 💬 on any digest row opens the full card with the
  clarification thread.
- **Agent-outage handling** — an unreachable API never fails an update or
  triggers a Telegram retry loop; DMs get a plain sentence naming the cause,
  the group stays quiet, commands and the digest keep working.
- **Tests** — 66 passing (`npm test`), covering the state machine, ranking
  and rotation, list-cap behaviour, digest assembly and timezone gating,
  inbox intent handling against fixtures, task matching, agent-output
  sanitising, and the Telegram codec/update parser.

## Evals

`npm run eval` scores the parsing agent against `evals/cases.jsonl` — 32
cases covering every intent, including seven chit-chat negatives and the two
messages that failed in real use. Grading is programmatic: intent is a
closed set and the fields are structured, so a judge model would add cost
and noise without measuring anything a direct comparison misses.

Reported per run: intent accuracy, exact field match, **chit-chat false
positive rate** (the one that matters most — a junk task in the family's
list is worse than a missed one), and actionable miss rate. Exits non-zero
below `--min` (default 0.85) so it can gate a deploy.

`--fixtures <file>` scores recorded parses without calling the API; that is
how the grader itself is tested.

## Verified

`npm test` (66/66), `npm run typecheck` clean, and a CLI walkthrough:
seed → `/add` → `/tasks` → button tap → task detail → digest → `/me`.

**Request shape confirmed against the live API.** Real calls reached
Anthropic and were rejected at billing (400, empty account) and at auth
(401, bad key) — both of which mean the model id, strict tool schema and
`output_config.effort` were accepted. The failure path is now covered end
to end.

**Parse quality measured:** intent accuracy 1.0, exact match 0.969,
chit-chat false-positive rate 0.0 across 32 cases. See
`evals/baseline.json`.

## Next

1. **Buy credits** — console.anthropic.com → Plans & Billing. Until then
   every free-text message is refused; slash commands work regardless.
2. **Set up the bot** — see README "Going live". Needs from you: a bot token
   from BotFather, a Cloudflare account, an Anthropic API key.
3. **Live-test the agents** — `ANTHROPIC_API_KEY=… npm run cli -- say 1001
   "can you book the dentist for friday, it's urgent"` and check the parse.
4. **DMs first, then the group** — add the bot to the family group and run
   `/here` only once DMs feel right.
5. **Tune the group prefilter** (`looksActionable`) against real messages.

## If this moves to a business account

ARCHITECTURE.md → "Moving to another account" has the commands. Short
version: GitHub and Anthropic are minutes, Cloudflare is a redeploy plus a
D1 export/import, and the Telegram bot cannot be transferred between
Telegram accounts — that means a new bot and everyone running `/start` once.

Run the D1 export periodically anyway; it is the only backup of the tasks.

## Not built, deliberately

Multi-tenant auth, self-serve onboarding, billing, admin tooling. `family_id`
and the channel interface are the only concessions to a possible future.
