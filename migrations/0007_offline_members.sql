-- A family member with no device: a young kid, a grandparent. They own tasks
-- and are named on them like anyone else, they just cannot be messaged.
-- Their channel is 'offline' and channel_chat_id stays NULL, which the digest
-- and notification paths already treat as "unreachable, skip".
--
-- Skipping them silently was the bug: their tasks then appeared in nobody's
-- digest at all. A guardian is the family member who sees that work on their
-- behalf, which is how it actually happens -- somebody with a phone reminds
-- the kid.
ALTER TABLE family_members
  ADD COLUMN guardian_member_id TEXT REFERENCES family_members(id) ON DELETE SET NULL;

CREATE INDEX idx_members_guardian ON family_members(guardian_member_id);
