# Runbook

How this was stood up, and everything that went wrong doing it. The
troubleshooting section is the useful half — each entry is a real failure
from the first deploy, not a hypothetical.

## Setup, start to finish

**Prerequisites:** Node 22+ (`node:sqlite` and TypeScript stripping both
need it), a Telegram account, a Cloudflare account, an Anthropic API key
with credit on it.

### 1. The bot

[@BotFather](https://t.me/BotFather) → `/newbot`. The username must be
globally unique and end in `bot`; obvious names are long gone, so expect to
add digits. You are done when BotFather replies **"Done! Congratulations on
your new bot"** and hands you a token.

Then `/mybots` → your bot → **Bot Settings** → **Group Privacy** → **Turn
off**. With privacy on — the default — the bot only sees group messages that
@-mention it, so group capture does not work. Change this *before* adding
the bot to a group; the setting is read when it joins.

### 2. Everything else

```bash
bash scripts/setup.sh
```

Creates the D1 database and writes its id into `wrangler.toml`, applies
migrations, prompts for the bot token and API key without echoing them,
generates the webhook secret itself, deploys, health-checks the Worker, and
registers the webhook. Re-runnable — it skips whatever is already done, and
records progress in `.famtask-setup` (gitignored, mode 600).

By hand, if you prefer: `wrangler d1 create famtask` → paste the id into
`wrangler.toml` → `npm run db:migrate` → `wrangler secret put` for each of
`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `TELEGRAM_WEBHOOK_SECRET` →
`npm run deploy` → `node scripts/set-webhook.mjs <worker url>`.

### 3. First run

DM the bot. **The first person to do so becomes the first family member.**
Add the second with `/adduser <their telegram id> <name>` — they get their
id by messaging the bot first. Set `/settz` or digests fire at 09:00 UTC.

Start with DMs. Add the bot to the family group only once that feels right.

---

## Mirroring tasks into Todoist (optional)

Off unless `TODOIST_TOKEN` is set. One-way: famtask stays the source of
truth and Todoist is a read-only audience, so the family can see tasks in an
app they already have without anyone learning a new one.

```bash
# Todoist → Settings → Integrations → Developer → copy the API token
npx wrangler secret put TODOIST_TOKEN
npm run db:migrate      # adds sync_links
npm run deploy
```

Each famtask list becomes a Todoist project of the same name, created on
first use. Share that project with the family from inside Todoist.

| famtask | Todoist |
|---|---|
| title / description | content / description |
| list | project |
| effective priority (incl. due-date escalation) | priority 4 / 2 / 1 |
| due date | due_date |
| assignee | a label, e.g. `@arjun` |
| `blocked` | label `@blocked` |
| `needs_clarification` | label `@needs-info` |
| `done` / `cancelled` | task closed |

**Completing a task in Todoist does not come back.** That is deliberate:
two writers over one row needs conflict rules this does not have. Mark
things done in Telegram.

Pushes run after the reply, never before it, so Todoist being slow or down
never delays an answer or fails a message. A failed push is retried on the
next message and on the hourly cron, because only a *successful* push is
recorded.

### Google Tasks

Not supported, and not planned. Google Tasks lists cannot be shared with
another person — each family member would see only their own — and it needs
per-user OAuth rather than a single token. Todoist has shared projects and a
personal API token, which is why it is the target.

## Troubleshooting

### The bot does not reply at all

Work outward from Telegram.

```bash
TELEGRAM_BOT_TOKEN=<token> node scripts/set-webhook.mjs --status
```

| Symptom | Cause | Fix |
|---|---|---|
| `url: (none)` | Webhook never registered — setup stopped early | Re-run `scripts/setup.sh`, or register manually |
| `last error: ...403` | Stored secret ≠ what Telegram sends | Re-set both from one shell (below) |
| `last error: ...500` | Worker throwing | `npx wrangler tail` for the exception |
| URL set, no error, pending > 0 | Telegram cannot reach the Worker | Check the URL is the one `npm run deploy` printed |
| URL set, no error, pending 0 | Delivered; the problem is inside the Worker | `npx wrangler tail` |

Then watch it live and send a message:

```bash
npx wrangler tail
```

A `POST .../telegram/webhook - Ok` with no error means the Worker ran and
chose not to reply. Every such path now logs — look for `parsed { intent,
confidence }`.

### `setWebhook: Not Found`

The bot token is not valid for any bot. Usually something else was passed —
the webhook secret, most often, since both are long opaque strings. A
BotFather token is `<digits>:<mixed>`, e.g.
`8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`. `set-webhook.mjs` now
rejects a malformed token before calling the API.

### The webhook registers but every update 403s

`TELEGRAM_WEBHOOK_SECRET` in Cloudflare must equal the `secret_token` given
to `setWebhook`. Set both from one shell so the value is never retyped:

```bash
SECRET=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
printf '%s' "$SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
TELEGRAM_BOT_TOKEN='<token>' TELEGRAM_WEBHOOK_SECRET="$SECRET" \
  node scripts/set-webhook.mjs https://famtask.famtask.workers.dev
```

This also never prints the secret, which matters — anyone holding it plus
the Worker URL can post forged Telegram updates.

### Wrong Worker URL

Use exactly what `npm run deploy` prints. The form is
`https://<worker>.<account subdomain>.workers.dev`, and when the two happen
to match it reads as a typo — `https://famtask.famtask.workers.dev` is
correct here. Dropping the subdomain gives a URL that 404s, and Telegram
then silently drops every update. `set-webhook.mjs` now probes `/health`
before registering.

### BotFather says "invalid bot" on `/setprivacy`

The bot does not exist — `/newbot` did not complete, usually because the
username was taken. Check with `/mybots`. If it is listed, use `/mybots` →
bot → Bot Settings → Group Privacy instead; `/setprivacy` asks you to pick
from a pop-up keyboard and typing the name by hand fails without the `@`.

### "the Anthropic account is out of credit"

Exactly what it says. console.anthropic.com → Plans & Billing → Buy credits.
Slash commands keep working meanwhile; only free-text parsing needs the API.

### "the API rejected the request: <field>"

A request-shape bug, not billing — both arrive as HTTP 400, which is why the
message quotes the field the API names. Seen once for real: the parser's
tool schema used JSON Schema type arrays (`type: ["string", "null"]`), which
strict tool use does not accept. Optional fields are now plain types the
model omits.

### The bot replies "I wasn't confident enough (0.90)"

Fixed, but worth understanding. The parser returned `new_task` with an
**empty `tasks` array**, so nothing was created, and the fallback message
then blamed confidence — at 0.90. A confident `new_task` with nothing
extracted now falls back to the person's own words as the title. If the eval
shows this recurring, force the tool call instead of `tool_choice: auto`.

### Every extracted field comes back empty

Symptom: intent and confidence arrive, and `tasks`, `priority`, `due_date`,
`new_state`, `query` are absent on every single message.

Cause: under `strict: true`, a property that is not listed in `required` is
**never emitted** — the compiled schema does not permit it. Marking fields
optional by leaving them out of `required` silently produces a two-field
tool.

Fix: every property goes in `required`, and optional ones are
`anyOf: [<schema>, {type: 'null'}]`. Type arrays (`type: ["string","null"]`)
are separately rejected with a 400. A test asserts both rules over the whole
schema — see `test/engine.test.ts` → "strict tool schema".

Downstream tell: intents drift to whichever value needs no extra fields. In
the observed run, seven `new_task` messages came back as `comment` because
`tasks` could not be emitted.

### `git pull` refuses: local changes to `package-lock.json`

`npm install` rewrote it locally. Nothing you authored:

```bash
git checkout -- package-lock.json && git pull
```

### Deploy or install fails on peer dependencies

`wrangler` 4 requires `@cloudflare/workers-types` 5. Upgrade them together:
`npm i -D wrangler@4 @cloudflare/workers-types@5`.

---

## Operations

### Reset the tasks, keep the family

```bash
npx wrangler d1 execute famtask --remote \
  --command "DELETE FROM digest_sends; DELETE FROM task_events; DELETE FROM tasks;"
```

Children first, so it works regardless of foreign-key cascade settings.

### Full reset, back to the bootstrap flow

```bash
npx wrangler d1 execute famtask --remote \
  --command "DELETE FROM digest_sends; DELETE FROM task_events; DELETE FROM tasks; DELETE FROM member_digest_lists; DELETE FROM lists; DELETE FROM family_members; DELETE FROM families; DELETE FROM app_state;"
```

### Back up

The only copy of the family's tasks. Worth running periodically.

```bash
npx wrangler d1 export famtask --remote --output famtask-backup.sql
```

### Seeing tasks from Telegram

| | |
|---|---|
| `/all` | every open task in the family, whoever owns it |
| `/tasks` | just yours |
| `/open` | unclaimed only |
| `/list <name>` | one list, everyone's |
| `/lists` | list names |

`/all` and `/list` exclude other members' *personal* lists; shared lists are
visible to everyone.

### Inspect

```bash
npx wrangler d1 execute famtask --remote --command "SELECT id, title, state, priority, due_at FROM tasks"
npx wrangler d1 execute famtask --remote --command "SELECT name, telegram_user_id, timezone, digest_hour FROM family_members"
```

### Test without touching production

```bash
npm test                                   # 52 unit tests, no API
npm run cli -- seed                        # local SQLite, console instead of Telegram
npm run cli -- say 1001 "book the dentist friday"
npm run cli -- digest --now 2026-09-12T09:00:00Z
rm famtask.local.sqlite                    # reset local
ANTHROPIC_API_KEY=... npm run eval         # 32 cases against the real API
```

### Force a digest

The cron runs hourly and only messages people whose local hour matches their
`digest_hour`. To see one now, set your hour to the next one to tick over
(`/settime`), or run it locally against the CLI database with
`npm run cli -- digest --now <ISO timestamp>`.
