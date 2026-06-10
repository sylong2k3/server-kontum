/**
 * Token Manager — Quản lý JWT Access Token & Refresh Token
 *
 * Access Token:
 *   - Ngắn hạn (mặc định 7d, cấu hình qua .env JWT_ACCESS_EXPIRES_IN)
 *   - Chứa payload: { userId, email, role, jti }
 *   - jti (JWT ID) dùng để blacklist khi logout
 *
 * Refresh Token:
 *   - Dài hạn (mặc định 30d, cấu hình qua .env JWT_REFRESH_EXPIRES_IN)
 *   - Hash SHA-256 lưu trong DB, token gốc trả cho client
 *   - Khi refresh: client gửi token gốc → server hash → tìm trong DB
 */

const jwt = require('jsonwebtoken');
const { generateUUID } = require('./cryptoHelper');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_SECRET_REFRESH = process.env.JWT_SECRET_REFRESH;
const JWT_ALGORITHM = process.env.JWT_ALGORITHM || 'HS256';
const JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '7d';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

/**
 * Tạo Access Token
 * @param {{ userId: number, email: string, role: string }} payload
 * @returns {{ token: string, jti: string, expiresAt: Date }}
 */
const generateAccessToken = (payload) => {
    const jti = generateUUID();

    const token = jwt.sign(
        {
            userId: payload.userId,
            email: payload.email,
            role: payload.role,
            jti,
        },
        JWT_SECRET,
        {
            algorithm: JWT_ALGORITHM,
            expiresIn: JWT_ACCESS_EXPIRES_IN,
        }
    );

    // Decode để lấy expiresAt chính xác
    const decoded = jwt.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);

    return { token, jti, expiresAt };
};

/**
 * Tạo Refresh Token
 * @param {{ userId: number }} payload
 * @returns {{ token: string, expiresAt: Date }}
 */
const generateRefreshToken = (payload) => {
    const token = jwt.sign(
        {
            userId: payload.userId,
            type: 'refresh',
        },
        JWT_SECRET_REFRESH,
        {
            algorithm: JWT_ALGORITHM,
            expiresIn: JWT_REFRESH_EXPIRES_IN,
        }
    );

    const decoded = jwt.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);

    return { token, expiresAt };
};

/**
 * Tạo cả Access Token + Refresh Token
 * @param {{ userId: number, email: string, role: string }} payload
 * @returns {{ accessToken: string, refreshToken: string, jti: string, accessExpiresAt: Date, refreshExpiresAt: Date }}
 */
const generateTokenPair = (payload) => {
    const access = generateAccessToken(payload);
    const refresh = generateRefreshToken({ userId: payload.userId });

    return {
        accessToken: access.token,
        refreshToken: refresh.token,
        jti: access.jti,
        accessExpiresAt: access.expiresAt,
        refreshExpiresAt: refresh.expiresAt,
    };
};

/**
 * Verify Access Token (không check blacklist — blacklist check ở middleware)
 * @param {string} token
 * @returns {object} — Decoded payload
 * @throws {JsonWebTokenError | TokenExpiredError}
 */
const verifyAccessToken = (token) => {
    return jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
};

/**
 * Verify Refresh Token
 * @param {string} token
 * @returns {object} — Decoded payload
 * @throws {JsonWebTokenError | TokenExpiredError}
 */
const verifyRefreshToken = (token) => {
    return jwt.verify(token, JWT_SECRET_REFRESH, { algorithms: [JWT_ALGORITHM] });
};

module.exports = {
    generateAccessToken,
    generateRefreshToken,
    generateTokenPair,
    verifyAccessToken,
    verifyRefreshToken,
    JWT_SECRET,
    JWT_ALGORITHM,
};
