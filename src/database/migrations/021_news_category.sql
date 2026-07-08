-- Add news category for specialized Sở NN&MT news.
ALTER TABLE cms.news
    ADD COLUMN IF NOT EXISTS category VARCHAR(40) NOT NULL DEFAULT 'general';

ALTER TABLE cms.news
    DROP CONSTRAINT IF EXISTS chk_news_category;

ALTER TABLE cms.news
    ADD CONSTRAINT chk_news_category CHECK (category IN ('general', 'so_nnmt'));

CREATE INDEX IF NOT EXISTS idx_news_category_status_published_at
    ON cms.news (category, status, published_at DESC)
    WHERE deleted_at IS NULL;
