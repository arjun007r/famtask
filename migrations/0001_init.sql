-- famtask initial schema. SQLite dialect: runs on Cloudflare D1 and on
-- node:sqlite for local tests. All ids are TEXT uuids, all timestamps are
-- ISO-8601 UTC strings.

CREATE TABLE families (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- Telegram chat id of the shared family group, once the bot is added.
  group_chat_id TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE family_members (
  id               TEXT PRIMARY KEY,
  family_id        TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  -- DM chat id, learned the first time they message the bot. Until it is
  -- set the member cannot receive a digest.
  telegram_chat_id TEXT,
  timezone         TEXT NOT NULL DEFAULT 'UTC',
  digest_hour      INTEGER NOT NULL DEFAULT 9,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_members_telegram_user ON family_members(telegram_user_id);
CREATE INDEX idx_members_family ON family_members(family_id);

CREATE TABLE lists (
  id              TEXT PRIMARY KEY,
  family_id       TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- NULL owner = shared list, visible to the whole family.
  owner_member_id TEXT REFERENCES family_members(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  archived_at     TEXT
);
CREATE UNIQUE INDEX idx_lists_family_name ON lists(family_id, name);

-- Per-person "which 3 lists feed my daily digest" setting. Empty for a
-- member means "all their lists", which is correct while they have <= 3.
CREATE TABLE member_digest_lists (
  member_id TEXT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  list_id   TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  PRIMARY KEY (member_id, list_id)
);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  family_id     TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  list_id       TEXT NOT NULL REFERENCES lists(id),
  title         TEXT NOT NULL,
  description   TEXT,
  created_by    TEXT REFERENCES family_members(id) ON DELETE SET NULL,
  -- assignee_kind 'member' => assigned_to set; 'group' / 'unassigned' => NULL.
  assignee_kind TEXT NOT NULL DEFAULT 'unassigned'
                CHECK (assignee_kind IN ('member', 'group', 'unassigned')),
  assigned_to   TEXT REFERENCES family_members(id) ON DELETE SET NULL,
  state         TEXT NOT NULL DEFAULT 'todo'
                CHECK (state IN ('todo','in_progress','blocked','needs_clarification','done','cancelled')),
  priority      TEXT NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('high','medium','low')),
  due_at        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_at     TEXT,
  source_chat_id    TEXT,
  source_message_id TEXT,
  CHECK ((assignee_kind = 'member') = (assigned_to IS NOT NULL))
);
CREATE INDEX idx_tasks_assignee ON tasks(assigned_to, state);
CREATE INDEX idx_tasks_list ON tasks(list_id, state);
CREATE INDEX idx_tasks_family_open ON tasks(family_id, state);

-- Thread history and audit trail in one stream.
CREATE TABLE task_events (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_member_id TEXT REFERENCES family_members(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL
                  CHECK (kind IN ('created','comment','state_change','reassigned','priority_change','edited')),
  from_state      TEXT,
  to_state        TEXT,
  body            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_events_task ON task_events(task_id, created_at);

-- One row per (member, task) digest appearance. Drives "next digest shows
-- the next batch" without ever losing a task.
CREATE TABLE digest_sends (
  id         TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sent_on    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_digest_sends_unique ON digest_sends(member_id, task_id, sent_on);
CREATE INDEX idx_digest_sends_member ON digest_sends(member_id, task_id);

-- Telegram redelivers on any non-200. Dedupe so a retry is a no-op.
CREATE TABLE processed_updates (
  update_id  TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
