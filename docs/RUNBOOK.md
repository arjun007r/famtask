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

## Adding WhatsApp

Telegram keeps working throughout. This adds a second front door to the same
Worker and the same database; nobody has to move.

### 1. A phone number

You do **not** need a spare SIM. Meta gives up to two free "555" business
numbers, verified automatically. The catch: a 555 number cannot be migrated to
another WhatsApp Business Account later, so treat it as permanent for this
project.

A number that has ever been used on regular WhatsApp will be rejected.

### 2. Meta app

Create an app at developers.facebook.com, add the **WhatsApp** product, and
claim the free number. From the dashboard you need:

| Value | Becomes |
|---|---|
| Phone number ID | `WHATSAPP_PHONE_NUMBER_ID` |
| Permanent access token (System User) | `WHATSAPP_TOKEN` |
| App secret (Settings → Basic) | `WHATSAPP_APP_SECRET` |
| A string you invent | `WHATSAPP_VERIFY_TOKEN` |

Use a **System User** token, not the temporary 24-hour one from the Getting
Started panel, or the bot stops working tomorrow.

```bash
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_APP_SECRET
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npm run deploy
```

### 3. The webhook

In the app's WhatsApp → Configuration panel:

- Callback URL: `https://famtask.famtask.workers.dev/whatsapp/webhook`
- Verify token: whatever you set as `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **`messages`** field. Nothing else is read.

Meta calls the URL with a `GET` first and expects the challenge echoed back.
If it fails, the verify token does not match — the Worker returns 403 rather
than saying so, deliberately.

### 4. The digest template

Outside a 24-hour window from the person's last message, WhatsApp only
delivers pre-approved templates, and **template parameters cannot contain
newlines** — so the task list itself can never be one. famtask sends a nudge
instead and delivers the real digest when it is tapped.

Create a template under Message Templates:

- Name: `famtask_daily_digest` (or set `WHATSAPP_DIGEST_TEMPLATE` to match)
- Category: **Utility** (Marketing costs ~6× more and may be throttled)
- Language: English
- Body: `Morning {{1}} — you have {{2}} things on your list today.`
- Add one **Quick reply** button, labelled something like `Show me`

Approval usually takes under an hour. Until it is approved, digests sent
outside the window will fail and be logged; nothing else breaks.

### 5. Add the person

From Telegram, once she has messaged the WhatsApp number at least once:

```
/adduser whatsapp:15550001111 Preethi
```

Then she sends `/settz America/Los_Angeles` and `/settime 9` on WhatsApp.

### What she will not have

The family group board. WhatsApp's Groups API requires an Official Business
Account, which a household will not get. Unclaimed family tasks still reach
her in the "Up for grabs" tail of her own digest, with Claim buttons.

### Troubleshooting

**`Authentication error [code: 10000]` in the deploy workflow.** The token
reached Cloudflare but is not allowed to touch D1. Edit it at
`dash.cloudflare.com/profile/api-tokens` and add `Account · D1 · Edit`. The
Workers template alone is not enough. Worth confirming the token belongs to
the same account as `CLOUDFLARE_ACCOUNT_ID` too.

**Webhook verification fails.** `WHATSAPP_VERIFY_TOKEN` does not match what
you typed in the Meta dashboard. The Worker returns a bare 403.

**Messages arrive but nothing happens.** Check `npx wrangler tail`. A 403 on
`/whatsapp/webhook` means the signature check failed — usually
`WHATSAPP_APP_SECRET` is the App ID or a token rather than the secret.

**"Re-engagement message" / error 131047.** Expected outside 24 hours. If the
template fallback also fails, the template is not approved yet or the name
does not match `WHATSAPP_DIGEST_TEMPLATE`.

**Buttons missing on a long message.** WhatsApp caps an interactive body at
1024 characters; the adapter sends the text first and the buttons in a
follow-up rather than dropping them.

**Only some buttons appear.** Three is the reply-button cap and ten the list
cap. The adapter keeps one action per task before any second action, so
everything stays reachable through a task's `⋯` menu.

## Deploying

Pushing to `main` deploys, via `.github/workflows/deploy.yml`. It typechecks,
runs the tests, fills in the D1 id, **applies migrations, then deploys** — in
that order, because a deploy ahead of its schema takes the bot down until
somebody notices. A red test never ships.

One-time setup, both doable from a phone at
`github.com/arjun007r/famtask/settings/secrets/actions`:

| Secret | Where it comes from |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create. Start from **Edit Cloudflare Workers**, then **add `Account · D1 · Edit`** — the template does not include it, and without it both the id lookup and the migrations fail with error 10000. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → Account details |

Never paste either into a chat, a commit, or `wrangler.toml`.

To deploy without pushing anything — say after changing a secret — open the
**Actions** tab, pick **Deploy**, and Run workflow. That works from a phone.

Deploying by hand still works and is unchanged:

```bash
npm run db:migrate && npm run deploy
```

## Troubleshooting: deploys

**`binding DB of type d1 must have a valid database_id` (error 10021).**
`wrangler.toml` has the placeholder rather than the real id. It is tracked in
git, so if the real id was never committed, every `git pull` reverts it and the
next deploy fails this way. Fix it once and for all:

```bash
npm run config:d1     # reads it from the account wrangler is logged into
git add wrangler.toml && git commit -m "Point at the real D1 database"
```

A `database_id` is an identifier, not a credential -- using it still requires
account authentication -- so it belongs in the repo. `npm run deploy` now
refuses to start while a placeholder is present, and says which one.

**`ENOENT ... blake3_js_bg.wasm`.** A partial `node_modules`, usually an
`npm install` interrupted part-way through unpacking; `.wasm` files are
frequent casualties. `rm -rf node_modules && npm ci`. If that still fails,
`npm cache clean --force` and reinstall.
