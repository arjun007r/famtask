# famtask

Family task management over Telegram. Tasks get captured from ordinary chat,
tracked as they bounce between people, and pushed back out as a daily digest
with one-tap buttons.

Cloudflare Workers + D1 + Cron Triggers, TypeScript, Claude for message
parsing and digest writing. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
schema, state machine, and design decisions; [PROGRESS.md](PROGRESS.md) for
what is built and what is next.

## Try it without a bot

The CLI drives the same code path the Worker does, against a local SQLite
file. No Telegram, no Cloudflare, no deploy.

```bash
npm install
npm test                       # 35 tests
npm run cli -- seed            # a family with two members and two lists
npm run cli -- say 1001 "/add Renew the car insurance"
npm run cli -- say 1001 "/tasks"
npm run cli -- digest --now 2026-09-10T09:00:00Z
```

Add `ANTHROPIC_API_KEY` to the environment and free text works too:

```bash
npm run cli -- say 1001 "priya can you book the dentist friday, it's urgent"
npm run cli -- group 1002 "someone needs to sort the recycling"
npm run cli -- tasks
```

Without the key, slash commands still work and free text is ignored.

## Going live

**What you need:** a bot token from [@BotFather](https://t.me/BotFather), a
Cloudflare account, and an Anthropic API key with credit on it.

In BotFather: `/newbot`, then `/mybots` → your bot → **Bot Settings** →
**Group Privacy** → **Turn off**, so it can read group messages rather than
only ones that @-mention it. (Change this *before* adding it to a group — the
setting is read when it joins.)

Then one command:

```bash
bash scripts/setup.sh
```

It creates the D1 database and writes the id into `wrangler.toml`, applies
migrations, prompts for the two secrets without echoing them, generates the
webhook secret itself, deploys, and registers the webhook. Safe to re-run —
it skips whatever is already done.

Prefer to do it by hand? The steps are: `wrangler d1 create famtask` (paste
the id into `wrangler.toml`), `npm run db:migrate`, `wrangler secret put`
for `TELEGRAM_BOT_TOKEN` / `ANTHROPIC_API_KEY` / `TELEGRAM_WEBHOOK_SECRET`,
`npm run deploy`, then:

```bash
TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<same secret> \
  node scripts/set-webhook.mjs https://famtask.<subdomain>.workers.dev
```

### First run

DM the bot — **the first person to do so becomes the first family member**.
Add the second person with `/adduser <their telegram id> <name>`; they get
their id by messaging the bot first.

Start with DMs. Add the bot to the family group only once that feels right;
it registers the group automatically, or run `/here` inside it.

### If the bot goes quiet

```bash
TELEGRAM_BOT_TOKEN=<token> node scripts/set-webhook.mjs --status   # last delivery error
npx wrangler tail                                                  # live logs
```

## Commands

```
/tasks            your open tasks          /lists            all lists
/next             the single next thing    /list <name>      one list
/open             unclaimed family tasks   /newlist <name>   create a list
/add <text>       add a task directly      /digestlists      pick your 3 digest lists
/settime <0-23>   digest hour              /settz <zone>     timezone
/members          who is in the family     /adduser <id> <name>
/here             bind the family group    /me               your settings
```

Or just talk to it — normal messages are read too.

## Local development

```bash
npm run typecheck
npm test
cp .dev.vars.example .dev.vars   # fill in, then:
npm run db:migrate:local
npm run dev
```
