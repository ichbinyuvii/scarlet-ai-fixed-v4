CREATE TABLE generated_images (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users ON DELETE CASCADE,
 prompt text NOT NULL,mime text NOT NULL,original text NOT NULL,provider text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generated_images_owner ON generated_images(user_id,created_at DESC);
