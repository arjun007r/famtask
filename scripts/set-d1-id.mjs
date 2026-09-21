/**
 * Write the real D1 database id into wrangler.toml, read from the account
 * wrangler is already authenticated against. Beats copying a uuid by hand,
 * and beats pasting one into a chat window.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../wrangler.toml', import.meta.url);
const toml = readFileSync(path, 'utf8');
const name = /database_name\s*=\s*"([^"]+)"/.exec(toml)?.[1];
if (!name) {
  console.error('No database_name in wrangler.toml; nothing to look up.');
  process.exit(1);
}

let listed;
try {
  listed = execFileSync('npx', ['--no-install', 'wrangler', 'd1', 'list', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} catch {
  // Two very different failures reach here, and telling someone to run
  // `wrangler login` inside CI -- where there is no browser and no one to
  // click anything -- sends them the wrong way entirely.
  console.error(
    process.env.CLOUDFLARE_API_TOKEN
      ? [
          '',
          'Cloudflare refused the API token (error 10000 is an authentication',
          'error, not a missing login).',
          '',
          'The "Edit Cloudflare Workers" template does not grant D1. Edit the',
          'token at dash.cloudflare.com/profile/api-tokens and add:',
          '',
          '  Account · D1 · Edit',
          '',
          'Check too that the token belongs to the same account as',
          'CLOUDFLARE_ACCOUNT_ID, and that it was pasted without stray',
          'whitespace.',
        ].join('\n')
      : 'No CLOUDFLARE_API_TOKEN set. Run `npx wrangler login` first, or set the token.',
  );
  process.exit(1);
}

const match = JSON.parse(listed).find((d) => d.name === name);
if (!match?.uuid) {
  console.error(`No D1 database called "${name}" on this account.`);
  process.exit(1);
}

writeFileSync(path, toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${match.uuid}"`));
console.log(`wrangler.toml now points at "${name}".`);
console.log('Commit it, so the next pull does not revert it.');
