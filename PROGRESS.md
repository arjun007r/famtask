# Progress

## Built

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
- **Notifications** — assignment, reassignment, status changes and comments
  DM the other party immediately; the daily digest is the backstop, not the
  only channel.
- **Task detail view** — 💬 on any digest row opens the full card with the
  clarification thread.
- **Agent-outage handling** — an unreachable API never fails an update or
  triggers a Telegram retry loop; DMs get a plain sentence naming the cause,
  the group stays quiet, commands and the digest keep working.
- **Tests** — 41 passing (`npm test`), covering the state machine, ranking
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

`npm test` (41/41), `npm run typecheck` clean, and a CLI walkthrough:
seed → `/add` → `/tasks` → button tap → task detail → digest → `/me`.

**Request shape confirmed against the live API.** Real calls reached
Anthropic and were rejected at billing (400, empty account) and at auth
(401, bad key) — both of which mean the model id, strict tool schema and
`output_config.effort` were accepted. The failure path is now covered end
to end.

**Still unverified: parse quality.** No successful completion has run, so
how well the parser classifies real family chat is unmeasured. That is
step 1 below and needs credit on the account.

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
