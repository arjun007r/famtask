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
- **Tests** — 35 passing (`npm test`), covering the state machine, ranking
  and rotation, list-cap behaviour, digest assembly and timezone gating,
  inbox intent handling against fixtures, task matching, agent-output
  sanitising, and the Telegram codec/update parser.

## Verified

`npm test` (35/35), `npm run typecheck` clean, and a CLI walkthrough:
seed → `/add` → `/tasks` → button tap → digest → `/me`.

**Not yet verified:** the two agents against the live Claude API — no
`ANTHROPIC_API_KEY` was available in the build environment. The request
shapes follow the current API (strict tool use, `output_config.effort`,
`claude-opus-5`), and both call sites degrade safely on a null result, but
the first real run is unproven. Test them with the CLI (below) before
pointing the bot at a real chat.

## Next

1. **Set up the bot** — see README "Going live". Needs from you: a bot token
   from BotFather, a Cloudflare account, an Anthropic API key.
2. **Live-test the agents** — `ANTHROPIC_API_KEY=… npm run cli -- say 1001
   "can you book the dentist for friday, it's urgent"` and check the parse.
3. **DMs first, then the group** — add the bot to the family group and run
   `/here` only once DMs feel right.
4. **Tune the group prefilter** (`looksActionable`) against real messages.

## Not built, deliberately

Multi-tenant auth, self-serve onboarding, billing, admin tooling. `family_id`
and the channel interface are the only concessions to a possible future.
