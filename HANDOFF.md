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
creation from free text, graceful degradation when the Anthropic API is
unreachable, and — as of 14 Sep 2026 — **the daily digest**, which fired on
schedule with the agent's intro line, the OVERDUE marker and due-date
priority escalation all correct on its first real run.

**Verified by tests:** 83 unit tests — state machine, ranking, due-date
escalation, the ≤3 digest-list rule, digest assembly and timezone gating,
inbox intents against fixtures, agent-outage handling, the Telegram codec,
the strict-schema invariants, the one-way mirror, line formatting, the
button flow (confirm-before-done, the ⋯ menu, reassignment, in-place
redraw, and taps on messages with no recorded view), and waiting-on
(outsider capture, the family-member guard, clearing, and `/waiting`).

**Measured:** parse quality, over 40 eval cases. The 7 waiting-on cases were
added after the numbers below and have only been scored against hand-written
fixtures — **re-run both models before trusting the table**.

| | intent | exact match | chit-chat false positives |
|---|---|---|---|
| `claude-opus-5` | 1.00 | 0.969 | 0.0 |
| `claude-haiku-4-5` | 0.97 | 0.97 | 0.0 |

Equivalent on everything that changes behaviour, at a fifth of the price —
Haiku is the recommendation. Full history and causes in
`evals/baseline.json`; re-run both before changing the parser prompt or
schema.

**Buttons are interactive as of 14 Sep 2026** — taps edit the message in
place rather than only firing a toast, `✓` confirms before finishing, and
every task carries a `⋯` menu with Blocked, Needs info and Reassign. The
reassign picker has never been used against a second real member.

**`waiting_on` added 15 Sep 2026**, needing migration `0004`. Untested
against real chat messages; the parser guidance for it has never met a live
model.

**Never run with two people.** Every task so far is Arjun's. Nothing has
exercised the notification path (assignee told immediately) or the bounce
states (`blocked` / `needs_clarification` travelling between two adults)
with a real second person on the other end. That is the next real test, and
the mechanic nothing else in the market models.

**Built but never exercised against the live API:** the Todoist mirror. The
reconcile logic is tested against a fake target; the HTTP layer is not, and
is off unless `TODOIST_TOKEN` is set.

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

1. **Add Preethi.** She DMs the bot, it replies with her Telegram id, then
   `/adduser <id> Preethi`. She sets her own `/settz`. This is the gating
   step for everything below — the app has never had two people in it.
2. **Watch the notification and bounce paths.** When a task is assigned to
   her she should be DM'd immediately, and when she sends it back blocked it
   should reach Arjun's digest. Both are built and tested, neither has run
   between two real people.
3. **Switch to Haiku** — `CLAUDE_MODEL` in `wrangler.toml`. Measured
   equivalent, a fifth of the cost.
4. **Then the group.** Turn Group Privacy off in BotFather *before* adding
   the bot, or it only sees @-mentions.
5. **Tune `looksActionable()`** in `src/app.ts` against real group messages.
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
