-- Add email_verified and verification_token to users
ALTER TABLE users ADD COLUMN email_verified integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verification_token text;
