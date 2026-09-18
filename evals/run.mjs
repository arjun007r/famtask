#!/usr/bin/env node
/**
 * Scores the parsing agent against evals/cases.jsonl.
 *
 *   ANTHROPIC_API_KEY=... node evals/run.mjs
 *   node evals/run.mjs --only task-hvac,chat-banter
 *   node evals/run.mjs --reps 3          # repeat each case, to see variance
 *   node evals/run.mjs --model claude-sonnet-5
 *   node evals/run.mjs --fixtures fixtures.jsonl   # score without calling the API
 *
 * Grading is programmatic: intent comes from a closed set and the extracted
 * fields are structured, so a judge model would add cost and noise without
 * measuring anything a direct comparison misses.
 *
 * Writes evals/results.json. Exits non-zero if intent accuracy drops below
 * --min (default 0.85), so this can gate a deploy.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { parseMessage } from '../src/agents/parser.ts';

// Pinned so relative dates in the cases ("tomorrow", "next monday") stay
// deterministic. Cases express expected dates absolutely against this.
const TODAY = '2026-09-11';
// A real household, not two adults: Maya has no phone of her own but is a
// family member the parser must be able to assign work to by name.
const MEMBERS = ['Arjun', 'Priya', 'Maya'];
const LISTS = ['Family', 'Business'];
// Context the update, query and clarification cases refer to.
//
// IMPORTANT when adding cases: no new_task case may describe something
// already in this list. If it does, reading it as an update to the existing
// task is the *correct* answer, and grading it as new_task marks a right
// answer wrong. That flaw cost a whole eval run.
const OPEN_TASKS = [
  'Book dentist appointment [Family] — Priya',
  'Renew car insurance [Family] — Arjun',
  'Gutter cleaning appointment [Family] — Arjun',
  'Book the car service [Family] — Arjun',
  'Call the plumber about the leak [Family] — Priya',
  'Sort out the recycling collection [Family] — group',
  'Clear out the loft [Family] — Arjun',
  'File the quarterly return [Business] — Arjun',
  'Return the library books [Family] — Maya',
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const only = flag('only')?.split(',').map((s) => s.trim());
const reps = Number(flag('reps', '1'));
const model = flag('model');
const minScore = Number(flag('min', '0.85'));
// Score recorded parses instead of calling the API. Used to test the grader
// itself, and to re-score a past run after changing what counts as correct.
const fixturesPath = flag('fixtures');
const fixtures = fixturesPath
  ? new Map(
      readFileSync(fixturesPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .map((row) => [row.id, row.parsed]),
    )
  : null;

if (!fixtures && !process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY. Every case is one real API call.');
  process.exit(1);
}

const client = fixtures ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const cases = readFileSync(new URL('cases.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((c) => !only || only.includes(c.id));

/** "the plumber" and "plumber" are the same answer. "none" is not. */
function nameMatches(got, want) {
  if (!got) return false;
  const w = String(want).toLowerCase();
  return got.includes(w) || w.includes(got);
}

/**
 * An expectation may be a single value or a list. Some phrasings have more
 * than one correct reading — "next Monday" said on a Friday is either the
 * coming Monday or the one after, and English does not settle it. Marking
 * one of those wrong measures the case author, not the model.
 */
function accepts(expected, got) {
  return [expected].flat().includes(got);
}

/** Field checks. Each returns null when it passes, or why it failed. */
function grade(c, parsed) {
  const e = c.expect;
  const fails = [];
  const speaker = c.speaker;

  const intentOk = parsed.intent === e.intent || (e.intent_alt ?? []).includes(parsed.intent);
  if (!intentOk) fails.push(`intent=${parsed.intent} want ${e.intent}`);

  const tasks = parsed.tasks ?? [];
  if (e.tasks !== undefined && tasks.length !== e.tasks) {
    fails.push(`tasks=${tasks.length} want ${e.tasks}`);
  }
  if (e.priority && tasks[0]?.priority !== e.priority) {
    fails.push(`priority=${tasks[0]?.priority ?? '-'} want ${e.priority}`);
  }
  if (e.due_date && !accepts(e.due_date, tasks[0]?.due_date)) {
    fails.push(`due=${tasks[0]?.due_date ?? '-'} want ${[e.due_date].flat().join(' or ')}`);
  }
  if (e.list) {
    // A list name lives on the query for a query, and on the task otherwise.
    const got = (e.scope ? parsed.query?.list : tasks[0]?.list) ?? '';
    if (got.toLowerCase() !== e.list.toLowerCase()) fails.push(`list=${got || '-'} want ${e.list}`);
  }
  if (e.assignee) {
    const got = (tasks[0]?.assignee ?? '').toLowerCase();
    const want = e.assignee === 'speaker' ? ['', speaker.toLowerCase(), 'me'] : [e.assignee.toLowerCase()];
    if (!want.includes(got)) fails.push(`assignee=${got || '-'} want ${e.assignee}`);
  }
  if ('waiting_on' in e) {
    // Names for outsiders are loose by nature ("the plumber" / "plumber"),
    // so this is a containment check either way -- but null means null.
    const got = (tasks[0]?.waiting_on ?? '').toLowerCase();
    if (e.waiting_on === null) {
      if (got) fails.push(`waiting_on=${got} want none`);
    } else if (!nameMatches(got, e.waiting_on)) {
      fails.push(`waiting_on=${got || '-'} want ${e.waiting_on}`);
    }
  }
  if ('new_waiting_on' in e) {
    const got = (parsed.new_waiting_on ?? '').toLowerCase();
    if (e.new_waiting_on === null) {
      if (got) fails.push(`new_waiting_on=${got} want none`);
    } else if (!nameMatches(got, e.new_waiting_on)) {
      fails.push(`new_waiting_on=${got || '-'} want ${e.new_waiting_on}`);
    }
  }
  if (e.new_state && parsed.new_state !== e.new_state) {
    fails.push(`state=${parsed.new_state ?? '-'} want ${e.new_state}`);
  }
  if (e.new_due_date && !accepts(e.new_due_date, parsed.new_due_date)) {
    fails.push(`new_due=${parsed.new_due_date ?? '-'} want ${[e.new_due_date].flat().join(' or ')}`);
  }
  if (e.new_assignee) {
    const got = (parsed.new_assignee ?? '').toLowerCase();
    if (got !== e.new_assignee.toLowerCase()) fails.push(`new_assignee=${got || '-'}`);
  }
  if (e.period && (parsed.query?.period ?? 'week') !== e.period) {
    fails.push(`period=${parsed.query?.period ?? '-'} want ${e.period}`);
  }
  if (e.scope && parsed.query?.scope !== e.scope) {
    fails.push(`scope=${parsed.query?.scope ?? '-'} want ${e.scope}`);
  }
  if (e.member && (parsed.query?.member ?? '').toLowerCase() !== e.member.toLowerCase()) {
    fails.push(`query.member=${parsed.query?.member ?? '-'}`);
  }
  // A correct intent the engine then discards on confidence is still a miss.
  const floor = c.chat === 'group' ? 0.65 : 0.5;
  if (e.intent !== 'chitchat' && intentOk && (parsed.confidence ?? 0) < floor) {
    fails.push(`confidence=${parsed.confidence} below ${floor} floor`);
  }
  return { intentOk, fails };
}

const results = [];
for (const c of cases) {
  for (let rep = 0; rep < reps; rep += 1) {
    let parsed = null;
    let error = null;
    if (fixtures) {
      parsed = fixtures.get(c.id) ?? null;
      if (!parsed) error = 'no fixture for this case';
    } else {
    try {
      parsed = await parseMessage(
        client,
        c.text,
        {
          speakerName: c.speaker,
          chatType: c.chat,
          memberNames: MEMBERS,
          listNames: LISTS,
          openTasks: OPEN_TASKS,
          today: TODAY,
        },
        model,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    }

    if (!parsed) {
      results.push({ id: c.id, rep, intentOk: false, fails: [error ?? 'no tool call'], parsed: null });
      process.stdout.write('E');
      continue;
    }
    const { intentOk, fails } = grade(c, parsed);
    results.push({ id: c.id, rep, intentOk, fails, parsed });
    process.stdout.write(fails.length === 0 ? '.' : intentOk ? '~' : 'X');
    // Flush every case: a run interrupted at case 30 should not lose 29.
    writeFileSync(new URL('results.json', import.meta.url), JSON.stringify({ results }, null, 2));
  }
}
process.stdout.write('\n\n');

// Chit-chat is the class that has to be right: a false positive writes a junk
// task into the family's list, which is worse than missing one.
const byId = new Map(cases.map((c) => [c.id, c]));
const chatty = results.filter((r) => byId.get(r.id).expect.intent === 'chitchat');
const actionable = results.filter((r) => byId.get(r.id).expect.intent !== 'chitchat');
const falsePositives = chatty.filter((r) => !r.intentOk);
const missed = actionable.filter((r) => !r.intentOk);

const intentAccuracy = results.filter((r) => r.intentOk).length / results.length;
const exact = results.filter((r) => r.fails.length === 0).length / results.length;

for (const r of results.filter((r) => r.fails.length > 0)) {
  const c = byId.get(r.id);
  console.log(`${r.intentOk ? '~' : 'X'} ${r.id}  "${c.text.slice(0, 58)}"`);
  console.log(`    ${r.fails.join('; ')}`);
}

const summary = {
  cases: cases.length,
  reps,
  runs: results.length,
  intent_accuracy: round(intentAccuracy),
  exact_match: round(exact),
  chitchat_false_positive_rate: round(falsePositives.length / Math.max(chatty.length, 1)),
  actionable_miss_rate: round(missed.length / Math.max(actionable.length, 1)),
  model: model ?? 'default (claude-opus-5)',
  today: TODAY,
  ran_at: new Date().toISOString(),
};
console.log('\n' + JSON.stringify(summary, null, 2));

writeFileSync(new URL('results.json', import.meta.url), JSON.stringify({ summary, results }, null, 2));
console.log('\nFull output in evals/results.json');

if (intentAccuracy < minScore) {
  console.error(`\nintent accuracy ${round(intentAccuracy)} is below --min ${minScore}`);
  process.exit(1);
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
