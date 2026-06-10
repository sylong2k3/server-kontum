/**
 * Crypto Helper — Hàm tiện ích mã hóa/hash
 *
 * Sử dụng bcrypt để hash và so sánh mật khẩu.
 * Sử dụng crypto (built-in) để hash SHA-256 cho refresh token.
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Số rounds cho bcrypt salt — 12 là mức cân bằng tốt giữa bảo mật và tốc độ
// Tăng lên 14 nếu server mạnh, giảm xuống 10 nếu server yếu
const SALT_ROUNDS = 12;

/**
 * Hash mật khẩu bằng bcrypt
 * @param {string} password — Mật khẩu plaintext
 * @returns {Promise<string>} — Hash string (~60 ký tự)
 */
const hashPassword = async (password) => {
    return bcrypt.hash(password, SALT_ROUNDS);
};

/**
 * So sánh mật khẩu plaintext với hash đã lưu
 * @param {string} password — Mật khẩu plaintext từ user
 * @param {string} hash — Hash đã lưu trong database
 * @returns {Promise<boolean>} — true nếu khớp
 */
const comparePassword = async (password, hash) => {
    return bcrypt.compare(password, hash);
};

/**
 * Hash SHA-256 cho refresh token
 * Không lưu refresh token gốc trong DB — chỉ lưu hash
 * @param {string} token — Refresh token string
 * @returns {string} — SHA-256 hex string (64 ký tự)
 */
const hashToken = (token) => {
    return crypto.createHash('sha256').update(token).digest('hex');
};

/**
 * Tạo UUID v4 — dùng làm JWT ID (jti)
 * @returns {string}
 */
const generateUUID = () => {
    return crypto.randomUUID();
};

module.exports = {
    hashPassword,
    comparePassword,
    hashToken,
    generateUUID,
};
