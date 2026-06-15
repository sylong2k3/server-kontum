-- ============================================================================
-- Migration 003: CMS MULTILINGUAL — news_translations + document_translations
--
-- Thêm bảng bản dịch để tách metadata chung (ảnh, trạng thái, tác giả…)
-- khỏi nội dung ngôn ngữ (tiêu đề, nội dung, mô tả).
--
-- Idempotent: dùng IF NOT EXISTS / ON CONFLICT DO NOTHING.
-- Phụ thuộc: 002_cms.sql (cms.news, cms.documents).
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
--  1. cms.news_translations — Bản dịch tin tức
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cms.news_translations (
    id          BIGSERIAL PRIMARY KEY,
    news_id     BIGINT NOT NULL REFERENCES cms.news(id) ON DELETE CASCADE,
    lang        VARCHAR(5) NOT NULL CHECK (lang IN ('vi', 'en')),
    title       VARCHAR(255) NOT NULL,
    slug        VARCHAR(255) NOT NULL,
    summary     TEXT,
    content     TEXT NOT NULL,
    search_tsv  TSVECTOR,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (news_id, lang)
);

-- Slug unique theo ngôn ngữ (cho phép slug giống nhau ở 2 ngôn ngữ khác nhau)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_news_translation_slug_lang
    ON cms.news_translations (slug, lang);

-- Index tìm kiếm full-text theo news_id
CREATE INDEX IF NOT EXISTS idx_news_translations_news_id
    ON cms.news_translations (news_id);

-- Index full-text search
CREATE INDEX IF NOT EXISTS idx_news_translations_search_tsv
    ON cms.news_translations USING GIN (search_tsv);

-- Hàm tạo search vector cho translation
CREATE OR REPLACE FUNCTION cms.update_news_translation_search_tsv()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_tsv := to_tsvector(
        'simple',
        coalesce(NEW.title, '') || ' ' ||
        coalesce(NEW.summary, '') || ' ' ||
        coalesce(NEW.content, '')
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_news_translations_search_tsv ON cms.news_translations;
CREATE TRIGGER trigger_news_translations_search_tsv
    BEFORE INSERT OR UPDATE OF title, summary, content ON cms.news_translations
    FOR EACH ROW
    EXECUTE FUNCTION cms.update_news_translation_search_tsv();

DROP TRIGGER IF EXISTS trigger_news_translations_updated_at ON cms.news_translations;
CREATE TRIGGER trigger_news_translations_updated_at
    BEFORE UPDATE ON cms.news_translations
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();


-- ════════════════════════════════════════════════════════════════════════════
--  2. cms.document_translations — Bản dịch tài liệu/báo cáo
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cms.document_translations (
    id              BIGSERIAL PRIMARY KEY,
    document_id     BIGINT NOT NULL REFERENCES cms.documents(id) ON DELETE CASCADE,
    lang            VARCHAR(5) NOT NULL CHECK (lang IN ('vi', 'en')),
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_document_translations_document_id
    ON cms.document_translations (document_id);

DROP TRIGGER IF EXISTS trigger_document_translations_updated_at ON cms.document_translations;
CREATE TRIGGER trigger_document_translations_updated_at
    BEFORE UPDATE ON cms.document_translations
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();


-- ════════════════════════════════════════════════════════════════════════════
--  3. Backfill — Chuyển dữ liệu cũ sang translation tables (lang = 'vi')
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO cms.news_translations (news_id, lang, title, slug, summary, content)
SELECT id, 'vi', title, slug, summary, content
FROM cms.news
WHERE deleted_at IS NULL
ON CONFLICT (news_id, lang) DO NOTHING;

INSERT INTO cms.document_translations (document_id, lang, title, description)
SELECT id, 'vi', title, description
FROM cms.documents
WHERE deleted_at IS NULL
ON CONFLICT (document_id, lang) DO NOTHING;
