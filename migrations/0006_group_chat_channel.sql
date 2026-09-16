-- The family group chat lives on exactly one channel, and which one was
-- previously implied by whichever adapter happened to be the default at send
-- time. Recording it makes the routing honest instead of accidental.
--
-- It stays a single group rather than one per channel on purpose: WhatsApp's
-- Groups API needs an Official Business Account, which a household will not
-- have. Members on a channel with no group still see unclaimed work in the
-- "Up for grabs" tail of their own digest, which is the part that matters.
ALTER TABLE families ADD COLUMN group_chat_channel TEXT;

UPDATE families SET group_chat_channel = 'telegram' WHERE group_chat_id IS NOT NULL;
