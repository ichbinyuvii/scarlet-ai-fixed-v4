ALTER TABLE connections ADD COLUMN IF NOT EXISTS public_meta jsonb NOT NULL DEFAULT '{}';
CREATE TABLE connector_checks(user_id text NOT NULL REFERENCES users ON DELETE CASCADE,kind text NOT NULL,status text NOT NULL,detail text NOT NULL DEFAULT '',last_success timestamptz,checked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,kind));
CREATE TABLE linkedin_dispatches(task_id text PRIMARY KEY,user_id text NOT NULL,author text NOT NULL,revision bigint NOT NULL,provider_id text,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id) ON DELETE CASCADE);
ALTER TABLE connector_checks ADD COLUMN enabled boolean NOT NULL DEFAULT true;
