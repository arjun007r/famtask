/**
 * Refuse to deploy a wrangler.toml that still has a placeholder in it.
 *
 * database_id is not a secret -- it names a database inside an account you
 * still need credentials to touch -- so the real one belongs in the repo.
 * While a placeholder lives there instead, every `git pull` quietly reverts
 * whoever filled it in, and the only symptom is a Cloudflare API error 10021
 * that says nothing about where the value went.
 */
import { readFileSync } from 'node:fs';

const path = new URL('../wrangler.toml', import.meta.url);
const toml = readFileSync(path, 'utf8');
const placeholders = [...toml.matchAll(/^\s*(\w+)\s*=\s*"(REPLACE_WITH_[^"]*)"/gm)];

if (placeholders.length > 0) {
  const lines = placeholders.map(([, key, value]) => `  ${key} = "${value}"`);
  console.error(
    [
      'wrangler.toml still has placeholders, so this deploy would fail at the',
      'Cloudflare API with a validation error that does not name the cause:',
      '',
      ...lines,
      '',
      'Fill them in with:',
      '',
      '  npm run config:d1',
      '',
      'then commit wrangler.toml so the next pull does not undo it.',
    ].join('\n'),
  );
  process.exit(1);
}
