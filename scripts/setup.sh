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

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

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
WEBHOOK_SECRET=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')

echo "$TELEGRAM_BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
echo "$ANTHROPIC_API_KEY"  | npx wrangler secret put ANTHROPIC_API_KEY
echo "$WEBHOOK_SECRET"     | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# --- deploy ----------------------------------------------------------------

say "Deploying"
DEPLOY_OUT=$(npx wrangler deploy 2>&1)
echo "$DEPLOY_OUT"
WORKER_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)

if [ -z "$WORKER_URL" ]; then
  printf '\nCould not read the Worker URL from the output. Paste it here: '
  read -r WORKER_URL
fi

say "Pointing Telegram at $WORKER_URL"
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" TELEGRAM_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  node scripts/set-webhook.mjs "$WORKER_URL"

say "Done."
cat <<EOF

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
