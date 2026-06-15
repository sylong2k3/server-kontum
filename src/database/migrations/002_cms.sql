-- ============================================================================
-- Migration 002: CMS NEWS + DOCUMENTS
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS cms;

CREATE TABLE IF NOT EXISTS cms.news (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    summary TEXT,
    content TEXT NOT NULL,
    cover_url TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    author_id BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ,
    search_tsv TSVECTOR,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_news_slug_active ON cms.news (slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_news_status_published_at ON cms.news (status, published_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_news_author_id ON cms.news (author_id);
CREATE INDEX IF NOT EXISTS idx_news_search_tsv ON cms.news USING GIN (search_tsv);

CREATE OR REPLACE FUNCTION cms.update_news_search_tsv()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_tsv := to_tsvector('simple', coalesce(NEW.title, '') || ' ' || coalesce(NEW.summary, '') || ' ' || coalesce(NEW.content, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_news_search_tsv ON cms.news;
CREATE TRIGGER trigger_news_search_tsv
    BEFORE INSERT OR UPDATE OF title, summary, content ON cms.news
    FOR EACH ROW
    EXECUTE FUNCTION cms.update_news_search_tsv();

DROP TRIGGER IF EXISTS trigger_news_updated_at ON cms.news;
CREATE TRIGGER trigger_news_updated_at
    BEFORE UPDATE ON cms.news
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();

CREATE TABLE IF NOT EXISTS cms.comments (
    id BIGSERIAL PRIMARY KEY,
    news_id BIGINT NOT NULL REFERENCES cms.news(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    is_approved BOOLEAN NOT NULL DEFAULT false,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_news_id ON cms.comments (news_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_comments_user_id ON cms.comments (user_id);

DROP TRIGGER IF EXISTS trigger_comments_updated_at ON cms.comments;
CREATE TRIGGER trigger_comments_updated_at
    BEFORE UPDATE ON cms.comments
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();

CREATE TABLE IF NOT EXISTS cms.documents (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    doc_type VARCHAR(30) NOT NULL CHECK (doc_type IN ('bao_cao', 'van_ban', 'pdf_map')),
    file_url TEXT NOT NULL,
    file_name VARCHAR(255),
    mime_type VARCHAR(150),
    file_size BIGINT,
    is_public BOOLEAN NOT NULL DEFAULT false,
    uploaded_by BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_type_created_at ON cms.documents (doc_type, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_public ON cms.documents (is_public) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_uploaded_by ON cms.documents (uploaded_by);

DROP TRIGGER IF EXISTS trigger_documents_updated_at ON cms.documents;
CREATE TRIGGER trigger_documents_updated_at
    BEFORE UPDATE ON cms.documents
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();
