ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_not_deleted
    ON auth.users (id)
    WHERE deleted_at IS NULL;
