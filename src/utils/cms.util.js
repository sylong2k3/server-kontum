const SUPPORTED_LANGS = ['vi', 'en'];
const DEFAULT_LANG = 'vi';

// ─── Slug helpers ─────────────────────────────────────────────────────────────

const stripDiacritics = (value = '') => value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');

const slugify = (value = '') => {
    const slug = stripDiacritics(value)
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return slug || 'tin-tuc';
};

// ─── HTML sanitize (strip toàn bộ tag cho plain-text fields) ─────────────────
// Dùng cho title, summary, description.
const stripTags = (value = '') => String(value)
    .replace(/<[^>]+>/gi, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .trim();

// Whitelist-based sanitize cho rich content (body bài tin).
// Giữ lại: p, br, b, strong, i, em, u, s, ul, ol, li,
//           blockquote, h2, h3, h4, a[href], img[src,alt].
// Xóa: script, style, on* attributes, javascript: href/src.
const sanitizeHtml = (value = '') => {
    let html = String(value);

    // 1. Xóa toàn bộ thẻ <script> (bao gồm nội dung)
    html = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
    // 2. Xóa toàn bộ thẻ <style>
    html = html.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '');
    // 3. Xóa toàn bộ thẻ không nằm trong whitelist
    html = html.replace(/<(?!\/?(?:p|br|b|strong|i|em|u|s|ul|ol|li|blockquote|h2|h3|h4|a|img)[\s>/])([^>]+)>/gi, '');
    // 4. Xóa mọi event handler (on...)
    html = html.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    // 5. Xóa javascript: trong href/src (mọi casing, spaces)
    html = html.replace(/(<(?:a|img)[^>]*\s(?:href|src)\s*=\s*["'])\s*javascript:[^"']*/gi, '$1#');
    // 6. Đảm bảo a tags có rel=noopener
    html = html.replace(/<a(\s[^>]*)?>/gi, (match) => {
        if (!/rel\s*=/i.test(match)) {
            return match.replace(/^<a/i, '<a rel="noopener noreferrer"');
        }
        return match;
    });

    return html;
};

// ─── Lang helpers ─────────────────────────────────────────────────────────────

const normalizeLang = (lang) => SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;

const fallbackLang = (lang) => {
    const normalized = normalizeLang(lang);
    return normalized === 'vi' ? 'en' : 'vi';
};

module.exports = {
    stripDiacritics,
    slugify,
    stripTags,
    sanitizeHtml,
    normalizeLang,
    fallbackLang,
    SUPPORTED_LANGS,
    DEFAULT_LANG,
};
