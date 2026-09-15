-- Work the family cannot do itself: the plumber, the school office, a
-- relative. The task still belongs to a family member -- the one chasing it --
-- so it keeps appearing in a digest instead of rotting. This column only
-- records who the outcome depends on.
--
-- Deliberately free text. Contractors and relatives are not worth a contacts
-- table, and one would turn a family task list into a CRM.
ALTER TABLE tasks ADD COLUMN waiting_on TEXT;

CREATE INDEX idx_tasks_waiting ON tasks(family_id, waiting_on);
