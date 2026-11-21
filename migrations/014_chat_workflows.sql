ALTER TABLE messages ADD COLUMN workflow_id text REFERENCES tasks(id) ON DELETE SET NULL;
