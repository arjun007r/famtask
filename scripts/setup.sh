#!/usr/bin/env bash
#
# One-command deploy: D1, secrets, migrations, Worker, webhook.
#
#   bash scripts/setup.sh
#
# Safe to re-run — it skips whatever is already done. Secrets are read
# without echoing and go straight to Cloudflare; none are written to disk.
set -euo pipefail

cd "$(dirname "$0")/.."

STATE_FILE=".famtask-setup"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\n\033[31m%s\033[0m\n' "$*" >&2
  [ -f "$STATE_FILE" ] && printf 'Progress so far is in %s — re-run this script to continue.\n' "$STATE_FILE" >&2
  exit 1
}

# The generated webhook secret has to survive a failure part-way through:
# it is stored in Cloudflare and must match what Telegram sends, so losing
# it means neither value can be reproduced. Kept out of git.
remember() { printf '%s=%s\n' "$1" "$2" >> "$STATE_FILE"; chmod 600 "$STATE_FILE"; }

# --- prerequisites ---------------------------------------------------------

command -v node >/dev/null || fail "Node is not installed. Install Node 22 or newer."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || fail "Node $NODE_MAJOR found; this needs 22 or newer (node:sqlite and TS stripping)."

say "Installing dependencies"
npm install --silent

say "Checking your Cloudflare login"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

# --- database --------------------------------------------------------------

DB_ID=$(grep -E '^database_id' wrangler.toml | sed -E 's/.*"(.*)".*/\1/')
if [ "$DB_ID" = "REPLACE_WITH_D1_DATABASE_ID" ]; then
  say "Creating the D1 database"
  CREATE_OUT=$(npx wrangler d1 create famtask 2>&1 || true)
  echo "$CREATE_OUT"
  DB_ID=$(echo "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)

  if [ -z "$DB_ID" ]; then
    # Already existed, or the output format changed. Ask D1 directly.
    DB_ID=$(npx wrangler d1 info famtask 2>/dev/null \
      | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
  fi
  [ -n "$DB_ID" ] || fail "Could not determine the database id. Run 'npx wrangler d1 info famtask' and paste the uuid into wrangler.toml yourself."

  # macOS and GNU sed disagree about -i, so rewrite the file in Node instead.
  node -e '
    const fs = require("fs");
    const f = "wrangler.toml";
    fs.writeFileSync(f, fs.readFileSync(f, "utf8")
      .replace("REPLACE_WITH_D1_DATABASE_ID", process.argv[1]));
  ' "$DB_ID"
  echo "wrangler.toml now points at $DB_ID"
else
  echo "Database already configured ($DB_ID)."
fi

say "Applying migrations"
npx wrangler d1 migrations apply famtask --remote

# --- secrets ---------------------------------------------------------------

say "Secrets"
echo "Nothing you type here is echoed, saved to disk, or committed."

printf 'Telegram bot token (from BotFather): '
read -rs TELEGRAM_BOT_TOKEN; echo
[ -n "$TELEGRAM_BOT_TOKEN" ] || fail "A bot token is required."

printf 'Anthropic API key (sk-ant-...): '
read -rs ANTHROPIC_API_KEY; echo
[ -n "$ANTHROPIC_API_KEY" ] || fail "An API key is required."

# Generated rather than chosen: this value must match in two places, and a
# typo there produces silent 403s with nothing pointing at the cause.
# Reused if an earlier run already generated one.
WEBHOOK_SECRET=$(grep -E '^TELEGRAM_WEBHOOK_SECRET=' "$STATE_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)
if [ -z "$WEBHOOK_SECRET" ]; then
  WEBHOOK_SECRET=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
  remember TELEGRAM_WEBHOOK_SECRET "$WEBHOOK_SECRET"
fi

printf '%s' "$TELEGRAM_BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
printf '%s' "$ANTHROPIC_API_KEY"  | npx wrangler secret put ANTHROPIC_API_KEY
printf '%s' "$WEBHOOK_SECRET"     | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# --- deploy ----------------------------------------------------------------

say "Deploying"
DEPLOY_OUT=$(npx wrangler deploy 2>&1)
echo "$DEPLOY_OUT"
WORKER_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)

if [ -z "$WORKER_URL" ]; then
  printf '\nCould not read the Worker URL from the output. Paste it here: '
  read -r WORKER_URL
fi
remember WORKER_URL "$WORKER_URL"

say "Checking the Worker is up"
curl -fsS "$WORKER_URL/health" >/dev/null \
  && echo "$WORKER_URL/health responded." \
  || echo "Health check failed — the webhook step below may not stick."

say "Pointing Telegram at $WORKER_URL"
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" TELEGRAM_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  node scripts/set-webhook.mjs "$WORKER_URL"

say "Done."
cat <<EOF

Worker:         $WORKER_URL
Webhook secret: $WEBHOOK_SECRET
  (also in $STATE_FILE, gitignored — needed to re-register the webhook)


Next:
  1. DM your bot on Telegram and say hello.
     The first person to do that becomes the first family member.
  2. Add your wife:  /adduser <her telegram id> <her name>
     She gets her id by messaging the bot first.
  3. Try it:  "book the dentist for friday, it's urgent"
  4. Only once DMs feel right, add the bot to the family group.

If the bot stays silent:
  TELEGRAM_BOT_TOKEN=<token> node scripts/set-webhook.mjs --status
  npx wrangler tail          # live logs
EOF
