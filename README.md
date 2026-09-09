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

**What I need from you:** a bot token, a Cloudflare account, an Anthropic API
key, and (later) the family group.

1. **Create the bot.** Message [@BotFather](https://t.me/BotFather) →
   `/newbot` → note the token and the bot's username. Then `/setprivacy` →
   **Disable**, so it can read group messages rather than only ones that
   @-mention it.

2. **Create the database.**
   ```bash
   npx wrangler d1 create famtask     # paste database_id into wrangler.toml
   npm run db:migrate
   ```

3. **Set secrets.**
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string you invent
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
   Add your bot's username to `[vars]` in `wrangler.toml` as
   `TELEGRAM_BOT_USERNAME` so group mentions are recognised.

4. **Deploy and register the webhook.**
   ```bash
   npm run deploy
   TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<same secret as step 3> \
     node scripts/set-webhook.mjs https://famtask.<subdomain>.workers.dev
   ```
   `node scripts/set-webhook.mjs --status` shows what is registered, the
   bot's username, and Telegram's last delivery error — the first place to
   look if the bot goes quiet.

5. **Bootstrap the family.** DM the bot. The first person to do so becomes
   the first member. Add the second:
   ```
   /adduser <their telegram id> <name>
   ```
   They get their id by messaging the bot before being added.

6. **Add the group, once DMs feel right.** Add the bot to the family group;
   it registers the chat automatically. If it does not, run `/here` inside
   the group.

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
