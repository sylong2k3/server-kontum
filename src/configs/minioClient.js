'use strict';

/**
 * MinIO Client — Singleton
 * Kết nối đến MinIO S3-compatible object storage.
 * Tự động tạo bucket nếu chưa tồn tại khi khởi động.
 */

const Minio = require('minio');

// ── Cấu hình từ biến môi trường ───────────────────────────────────────────────
const MINIO_CONFIG = {
    endPoint:        process.env.MINIO_ENDPOINT  || 'localhost',
    port:            Number(process.env.MINIO_PORT || 9000),
    useSSL:          process.env.MINIO_USE_SSL === 'true',
    accessKey:       process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey:       process.env.MINIO_SECRET_KEY || 'minioadmin',
};

const BUCKET_REMOTE_SENSING = process.env.MINIO_BUCKET_REMOTE_SENSING || 'remote-sensing-images';
const DEFAULT_REGION         = process.env.MINIO_REGION || 'us-east-1';

// ── Khởi tạo client (singleton) ───────────────────────────────────────────────
let _client = null;

const getClient = () => {
    if (!_client) {
        _client = new Minio.Client(MINIO_CONFIG);
    }
    return _client;
};

/**
 * Tạo bucket nếu chưa tồn tại.
 * @param {Minio.Client} client
 * @param {string}       bucketName
 */
const ensureBucket = async (client, bucketName) => {
    const exists = await client.bucketExists(bucketName);
    if (!exists) {
        await client.makeBucket(bucketName, DEFAULT_REGION);
        console.info(`[MinIO] Bucket "${bucketName}" đã được tạo.`);
    } else {
        console.info(`[MinIO] Bucket "${bucketName}" đã tồn tại.`);
    }
};

/**
 * Khởi tạo kết nối MinIO và tạo các bucket cần thiết.
 * Gọi hàm này một lần khi server khởi động.
 */
const initMinio = async () => {
    try {
        const client = getClient();
        await ensureBucket(client, BUCKET_REMOTE_SENSING);
        console.info('[MinIO] Kết nối thành công.');
    } catch (err) {
        // Không crash server nếu MinIO chưa sẵn sàng — worker sẽ retry
        console.error('[MinIO] Không thể kết nối:', err.message);
    }
};

/**
 * Kiểm tra sức khỏe kết nối MinIO.
 * @returns {Promise<boolean>}
 */
const healthCheck = async () => {
    try {
        const client = getClient();
        await client.bucketExists(BUCKET_REMOTE_SENSING);
        return true;
    } catch {
        return false;
    }
};

module.exports = {
    getClient,
    initMinio,
    healthCheck,
    BUCKET_REMOTE_SENSING,
    MINIO_CONFIG,
};
