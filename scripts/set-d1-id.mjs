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
  console.error('Could not list D1 databases. Run `npx wrangler login` first.');
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
