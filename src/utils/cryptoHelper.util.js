const bcrypt = require('bcrypt');
const crypto = require('crypto');

const SALT_ROUNDS = 12;

const hashPassword = async (password) => {
    return bcrypt.hash(password, SALT_ROUNDS);
};

const comparePassword = async (password, hash) => {
    return bcrypt.compare(password, hash);
};

const hashToken = (token) => {
    return crypto.createHash('sha256').update(token).digest('hex');
};

const generateUUID = () => {
    return crypto.randomUUID();
};

const generateRandomToken = (bytes = 32) => {
    return crypto.randomBytes(bytes).toString('base64url');
};

module.exports = {
    hashPassword,
    comparePassword,
    hashToken,
    generateUUID,
    generateRandomToken,
};
