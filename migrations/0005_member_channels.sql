-- A member is reachable on one messaging channel, which is not necessarily
-- the same one as everybody else. Two people in a household can refuse to
-- share an app and still share a task list.
--
-- The ids were never Telegram-shaped in any way that mattered -- a user id
-- and a conversation id -- so this is a rename, not a remodel.
ALTER TABLE family_members RENAME COLUMN telegram_user_id TO channel_user_id;
ALTER TABLE family_members RENAME COLUMN telegram_chat_id TO channel_chat_id;
ALTER TABLE family_members ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram';

-- Ids are only unique within their own channel: a Telegram user id and a
-- WhatsApp phone number live in different namespaces and could collide.
DROP INDEX IF EXISTS idx_members_telegram_user;
CREATE UNIQUE INDEX idx_members_channel_user ON family_members(channel, channel_user_id);
