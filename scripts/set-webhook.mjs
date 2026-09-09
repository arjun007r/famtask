#!/usr/bin/env node
/**
 * Point the bot at a deployed Worker. Registering the webhook by hand means
 * typing TELEGRAM_WEBHOOK_SECRET identically in two places, which is the
 * easiest step in the whole setup to get silently wrong -- a mismatch just
 * produces 403s and a bot that never answers.
 *
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
 *     node scripts/set-webhook.mjs https://famtask.<subdomain>.workers.dev
 *
 *   node scripts/set-webhook.mjs --status     # what is registered right now
 *   node scripts/set-webhook.mjs --delete
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const arg = process.argv[2];

if (!token) fail('Set TELEGRAM_BOT_TOKEN.');

const call = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!json.ok) fail(`${method}: ${json.description}`);
  return json.result;
};

if (arg === '--status') {
  const info = await call('getWebhookInfo');
  console.log(`url:              ${info.url || '(none)'}`);
  console.log(`pending updates:  ${info.pending_update_count ?? 0}`);
  if (info.last_error_message) {
    console.log(`last error:       ${info.last_error_message} (${new Date((info.last_error_date ?? 0) * 1000).toISOString()})`);
  }
  const me = await call('getMe');
  console.log(`bot:              @${me.username}`);
  console.log('\nPut that username in wrangler.toml as TELEGRAM_BOT_USERNAME so group mentions are recognised.');
} else if (arg === '--delete') {
  await call('deleteWebhook', { drop_pending_updates: false });
  console.log('Webhook removed.');
} else {
  if (!arg) fail('Usage: node scripts/set-webhook.mjs <worker origin>');
  if (!secret) fail('Set TELEGRAM_WEBHOOK_SECRET to the same value you gave `wrangler secret put`.');
  const url = `${arg.replace(/\/$/, '')}/telegram/webhook`;
  await call('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  });
  console.log(`Webhook set to ${url}`);
  console.log('Now DM the bot — the first person to do so becomes the first family member.');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
