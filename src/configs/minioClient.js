'use strict';

/**
 * MinIO Client — Singleton
 * Kết nối đến MinIO S3-compatible object storage.
 * Tự động tạo bucket nếu chưa tồn tại khi khởi động.
 */

const Minio = require('minio');
const { t } = require('../utils/i18n.util');

// ── Cấu hình từ biến môi trường ───────────────────────────────────────────────
const MINIO_CONFIG = {
    endPoint:        process.env.MINIO_ENDPOINT  || 'localhost',
    port:            Number(process.env.MINIO_PORT || 9000),
    useSSL:          process.env.MINIO_USE_SSL === 'true',
    accessKey:       process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey:       process.env.MINIO_SECRET_KEY || 'minioadmin',
};

const BUCKET_REMOTE_SENSING = process.env.MINIO_BUCKET_REMOTE_SENSING || 'remote-sensing-images';
const BUCKET_FIELD_MEASUREMENTS = process.env.MINIO_BUCKET_FIELD_MEASUREMENTS || 'field-measurement-photos';
const DEFAULT_REGION         = process.env.MINIO_REGION || 'us-east-1';

const getLang = () => process.env.APP_LANG || process.env.LANG || 'vi';

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
        console.info(t('minio_bucket_created', getLang(), { bucket: bucketName }));
    } else {
        console.info(t('minio_bucket_exists', getLang(), { bucket: bucketName }));
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
        await ensureBucket(client, BUCKET_FIELD_MEASUREMENTS);
        console.info(t('minio_connected', getLang()));
    } catch (err) {
        // Không crash server nếu MinIO chưa sẵn sàng — worker sẽ retry
        console.error(t('minio_connection_failed', getLang()), err.message);
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
    BUCKET_FIELD_MEASUREMENTS,
    MINIO_CONFIG,
};
