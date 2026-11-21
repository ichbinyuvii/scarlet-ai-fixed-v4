ALTER TABLE generated_images ADD COLUMN conversation_id text,ADD COLUMN message_id text,ADD COLUMN model text,ADD COLUMN size_bytes integer,ADD COLUMN width integer,ADD COLUMN height integer;
CREATE UNIQUE INDEX messages_owner_conversation_id ON messages(user_id,conversation_id,id);
INSERT INTO conversations(id,user_id,title,created_at) SELECT 'legacy-images-'||md5(user_id),user_id,'Generated images',min(created_at) FROM generated_images GROUP BY user_id;
INSERT INTO messages(id,user_id,conversation_id,role,body,created_at) SELECT 'legacy-prompt-'||md5(id),user_id,'legacy-images-'||md5(user_id),'user',prompt,created_at FROM generated_images;
INSERT INTO messages(id,user_id,conversation_id,role,body,created_at) SELECT 'legacy-image-'||md5(id),user_id,'legacy-images-'||md5(user_id),'assistant','Generated image.',created_at FROM generated_images;
UPDATE generated_images SET conversation_id='legacy-images-'||md5(user_id),message_id='legacy-image-'||md5(id);
ALTER TABLE generated_images ALTER COLUMN conversation_id SET NOT NULL,ALTER COLUMN message_id SET NOT NULL;
CREATE UNIQUE INDEX generated_image_message ON generated_images(user_id,conversation_id,message_id);
ALTER TABLE generated_images ADD FOREIGN KEY (user_id,conversation_id,message_id) REFERENCES messages(user_id,conversation_id,id) ON DELETE CASCADE;
CREATE TABLE image_requests (
 user_id text NOT NULL,
 request_id text NOT NULL,
 conversation_id text NOT NULL,
 fingerprint text NOT NULL,
 state text NOT NULL CHECK(state IN ('running','completed','failed','cancelled')),
 result_id text,
 started timestamptz NOT NULL DEFAULT now(),
 dispatched timestamptz,
 PRIMARY KEY (user_id,request_id),
 FOREIGN KEY (user_id,conversation_id) REFERENCES conversations(user_id,id) ON DELETE CASCADE
);
CREATE INDEX image_requests_running ON image_requests(user_id,started) WHERE state='running';
