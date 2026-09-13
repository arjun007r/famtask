-- What has been mirrored to an external task app, and in what shape.
-- synced_hash lets a reconcile skip tasks that have not changed, so the
-- sweep is cheap enough to run after every message.
CREATE TABLE sync_links (
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target      TEXT NOT NULL,
  external_id TEXT NOT NULL,
  synced_hash TEXT NOT NULL,
  synced_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, target)
);
CREATE INDEX idx_sync_links_target ON sync_links(target, external_id);
