const jwt = require('jsonwebtoken');
const { generateUUID } = require('./cryptoHelper');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_SECRET_REFRESH = process.env.JWT_SECRET_REFRESH;
const JWT_ALGORITHM = process.env.JWT_ALGORITHM || 'HS256';
const JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '7d';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

const generateAccessToken = (payload) => {
    const jti = generateUUID();
    const token = jwt.sign(
        { userId: payload.userId, email: payload.email, role: payload.role, jti },
        JWT_SECRET,
        { algorithm: JWT_ALGORITHM, expiresIn: JWT_ACCESS_EXPIRES_IN }
    );
    const decoded = jwt.decode(token);
    return { token, jti, expiresAt: new Date(decoded.exp * 1000) };
};

const generateRefreshToken = (payload) => {
    const token = jwt.sign(
        { userId: payload.userId, type: 'refresh' },
        JWT_SECRET_REFRESH,
        { algorithm: JWT_ALGORITHM, expiresIn: JWT_REFRESH_EXPIRES_IN }
    );
    const decoded = jwt.decode(token);
    return { token, expiresAt: new Date(decoded.exp * 1000) };
};

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

const verifyAccessToken = (token) => {
    return jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
};

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
