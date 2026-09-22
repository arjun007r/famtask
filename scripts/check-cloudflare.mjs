/**
 * Work out *why* Cloudflare refused, rather than guessing.
 *
 * Error 10000 is "Authentication error", which the API returns for several
 * quite different problems: a token that is not valid at all, a token that is
 * valid but scoped to a different account than CLOUDFLARE_ACCOUNT_ID, a token
 * missing the D1 permission, and a Global API Key pasted where an API Token
 * was wanted. Telling them apart by trying fixes is slow; asking Cloudflare
 * takes three requests.
 *
 * Prints no secrets. Account ids are shown as a short prefix, enough to
 * compare by eye and not enough to use.
 */
const API = 'https://api.cloudflare.com/client/v4';
const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';

const say = (...lines) => console.log(lines.join('\n'));
const short = (id) => (id ? `${id.slice(0, 6)}…${id.slice(-4)}` : '(unset)');

async function call(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

say('', '── Cloudflare credential check ────────────────────────────', '');

if (!token) {
  say('CLOUDFLARE_API_TOKEN is empty. The secret is not set, or is named differently.');
  process.exit(0);
}

// Shape first: the commonest mix-up is a Global API Key, which is 37 hex
// characters and is not a bearer token at all.
if (/^[a-f0-9]{37}$/.test(token)) {
  say(
    'That looks like a Global API Key, not an API Token.',
    '',
    'They are different things and wrangler wants the second. On',
    'dash.cloudflare.com/profile/api-tokens the Global API Key is the row at',
    'the BOTTOM of the page — use "Create Token" at the top instead.',
  );
  process.exit(0);
}
if (token !== token.trim()) {
  say('The token has leading or trailing whitespace. Re-paste it without the stray newline.');
}

const verify = await call('/user/tokens/verify');
if (!verify.body?.success) {
  const reason = verify.body?.errors?.[0];
  say(
    `The token itself is not valid (HTTP ${verify.status}${reason ? `, ${reason.code}: ${reason.message}` : ''}).`,
    '',
    'It has been revoked, mistyped, or truncated when pasted. Tokens are shown',
    'once, so a partial copy is easy — create a fresh one and replace the secret.',
  );
  process.exit(0);
}
say(`✓ Token is valid and active (status: ${verify.body.result?.status ?? 'unknown'}).`);

const accounts = await call('/accounts');
const list = accounts.body?.result ?? [];
if (!accounts.body?.success) {
  say('  Could not list accounts, so the token may lack Account Settings · Read.');
} else if (list.length === 0) {
  say('  The token can see no accounts at all, which usually means it is user-scoped only.');
} else {
  say('', 'Accounts this token can see:');
  for (const account of list) say(`  · ${account.name}  ${short(account.id)}`);
  const match = list.some((a) => a.id === accountId);
  say(
    '',
    `CLOUDFLARE_ACCOUNT_ID is ${short(accountId)} — ${
      match ? '✓ one of the above.' : '✗ NOT among them. That is the problem: the token belongs to a different account.'
    }`,
  );
  if (!match) process.exit(0);
}

const d1 = await call(`/accounts/${accountId}/d1/database`);
if (d1.body?.success) {
  const names = (d1.body.result ?? []).map((d) => d.name);
  say('', `✓ D1 is readable. Databases: ${names.join(', ') || '(none)'}`);
  if (!names.includes('famtask')) {
    say('  But there is no database called "famtask" on this account.');
  }
} else {
  const reason = d1.body?.errors?.[0];
  say(
    '',
    `✗ D1 refused (HTTP ${d1.status}${reason ? `, ${reason.code}: ${reason.message}` : ''}).`,
    '',
    'The token is valid for this account but cannot touch D1. Edit it at',
    'dash.cloudflare.com/profile/api-tokens and add the permission:',
    '',
    '    Account · D1 · Edit',
    '',
    'Saving an edited token keeps its value, so the GitHub secret stays as is.',
  );
}
say('', '───────────────────────────────────────────────────────────', '');
