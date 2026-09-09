-- Small key/value scratchpad for scheduler bookkeeping (e.g. "the group
-- board was already posted today"). Not for domain data.
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
