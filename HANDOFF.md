# Handoff

Read this first when picking the project up cold — in a new chat, a
different tool, or in six months. It is the state of the thing, not a
tutorial.

Then: [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and why,
[PROGRESS.md](PROGRESS.md) for what is built and next,
[docs/RUNBOOK.md](docs/RUNBOOK.md) for setup and troubleshooting.

## What this is

A family task manager that lives in Telegram. It reads ordinary chat
messages, turns the ones that are actually tasks into structured records,
tracks them as they bounce between people, and DMs each person a digest of
their top 5 each morning.

Built for one family — Arjun and his wife to start, extensible to more
people and a shared group chat. Not a product; deliberately not
multi-tenant.

## Live right now

| | |
|---|---|
| Repo | `arjun007r/famtask`, branch `main` |
| Worker | `https://famtask.famtask.workers.dev` |
| Bot | `@Rajafamtaskbot` |
| Database | Cloudflare D1, `famtask` |
| Model | `claude-opus-5` (override with the `CLAUDE_MODEL` var) |
| Cron | hourly, `0 * * * *` |

Secrets live in Cloudflare, never in the repo: `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`. `scripts/setup.sh` writes
the generated webhook secret to `.famtask-setup` (gitignored) because it has
to match on both sides and is otherwise unrecoverable.

## Status

**Working and verified in production:** the whole delivery chain (Telegram →
webhook → Worker → D1 → reply), the bootstrap flow, slash commands, task
creation from free text, and graceful degradation when the Anthropic API is
unreachable.

**Verified by tests:** 52 unit tests — state machine, ranking, due-date
escalation, the ≤3 digest-list rule, digest assembly and timezone gating,
inbox intents against fixtures, agent-outage handling, the Telegram codec.

**Measured once, then fixed:** the first eval run scored 0.78 intent
accuracy and 0.28 exact match — caused by a schema bug (optional fields
were unemittable under `strict: true`) and by eight eval cases that
duplicated tasks the fixture said already existed. Both fixed; not re-run
yet.

**Not yet measured:** parse quality after those fixes. `npm run eval` (32 cases) exists and the
grader is self-tested, but the first full run had not finished at handoff.
That number is the main open question — see Next.

**Never run in production:** the daily digest. The cron is registered but no
digest has fired for a real member yet. Nothing has exercised
`runScheduledDigests` outside tests.

## Decisions already made — don't relitigate

- **Six task states**: `todo`, `in_progress`, `blocked`,
  `needs_clarification`, `done`, `cancelled`. `blocked` and
  `needs_clarification` are first-class because tasks bounce; that is the
  point of the app.
- **Digest draws from at most 3 lists per person.** ≤3 lists, all of them
  automatically; more, they pick 3 and the rest stay queryable on demand.
- **Unclaimed group tasks appear in both** the group chat post and each
  person's DM digest, until someone claims them.
- **Cloudflare Workers + D1 + Cron**, chosen over Vercel + Supabase because
  Vercel's free cron fires once a day at a fixed time, which would kill
  per-person digest hours.
- **Overdue and priority escalation are derived from `due_at`, never
  stored.** Nothing sweeps a flag, nothing goes stale, and moving the
  deadline out de-escalates by itself.
- **A task with no named owner belongs to whoever raised it.** Only an
  explicit hand-off leaves it open to the family.
- **Messages are plain text, no markup.** Telegram's MarkdownV2 escaping is
  a reliable source of 500s and every channel renders emphasis differently.
- **Two agents, two modules**, never merged: `parser.ts` (message → intent)
  and `digest-writer.ts` (rank → prose).
- **Agent output is never trusted.** The digest agent may only permute the
  set it was handed; invented ids are dropped.
- **Task matching is deterministic word overlap, not a model call.** The
  agent already named its target; a second call would be slower and no more
  reliable on three-word titles.

## Rules for changing it

1. Nothing in `src/core/` may import from `src/telegram/`. Type-only imports
   of `src/channel/` and `src/agents/` types are fine.
2. Both agent call sites must work when the model returns nothing.
3. A DM always gets an answer, including when the engine correctly does
   nothing. In the group, silence on chit-chat is the point.
4. `family_id` stays on tasks, lists and members. Add nothing else for a
   hypothetical second family.
5. Run `npm run typecheck && npm test` before pushing. Run `npm run eval`
   before changing the parser prompt or schema.

## Next

1. **Read the eval result.** `npm run eval`. The number that matters most is
   `chitchat_false_positive_rate` — junk in the family's list is worse than
   a missed task.
2. **Watch for empty extraction.** The parser once returned `new_task` at
   0.90 confidence with an empty `tasks` array. There is now a fallback that
   uses the person's own words as the title, so it no longer loses work — but
   if the eval shows it recurring, switch `tool_choice` from `auto` to
   forcing the tool (Opus 5 supports it; see `src/agents/client.ts`).
3. **Add the second family member.** She DMs the bot, it replies with her
   Telegram id, then `/adduser <id> <name>`.
4. **Watch the first real digest.** Set `/settz` first or it fires at 09:00
   UTC. Nothing has ever run this path for real.
5. **Then the group.** Turn Group Privacy off in BotFather *before* adding
   the bot, or it only sees @-mentions.
6. **Tune `looksActionable()`** in `src/app.ts` against real group messages.
   It is a keyword prefilter that stops every idle message costing an API
   call, and it is guesswork until it has seen a week of real traffic.

## Known rough edges

- `editTask` supports changing the title and description, but only the due
  date is reachable from chat.
- `task_events` grows without bound. Irrelevant at family scale.
- No per-member permissions: any member can act on any task in a list they
  can see. Intentional.
- The D1 export is the only backup of the family's tasks. Nothing runs it on
  a schedule.
