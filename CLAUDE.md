# famtask — working notes

Start with [HANDOFF.md](HANDOFF.md) — what is live, what is verified, what
is decided, what is next. Then [ARCHITECTURE.md](ARCHITECTURE.md) (schema,
state machine, digest behaviour, open decisions),
[PROGRESS.md](PROGRESS.md) (built vs. next), and
[docs/RUNBOOK.md](docs/RUNBOOK.md) (setup and troubleshooting). They are the
source of truth — this conversation is not. Keep them current as you go.

## Rules

1. **The core engine must not know about Telegram or Claude.** Anything in
   `src/core/` importing from `src/telegram/` is a bug. Type-only imports of
   `src/channel/` and `src/agents/` types are fine.
2. **Two agent roles, two modules.** `agents/parser.ts` (message → intent)
   and `agents/digest-writer.ts` (rank → prose). Do not merge them into one
   prompt.
3. **Agent output is never trusted.** Sanitise it before it reaches the
   database or the screen; both call sites must work when the model returns
   nothing.
4. **Plain text out.** No Markdown, no HTML, no `parse_mode`.
5. `family_id` stays on tasks, lists, and members. Do not add anything else
   for a hypothetical second family.
6. Work incrementally — targeted edits, not file rewrites. Keep comments
   sparse and about *why*.

## Checks

```bash
npm run typecheck && npm test
npm run cli -- seed && npm run cli -- say 1001 "/tasks"
```
