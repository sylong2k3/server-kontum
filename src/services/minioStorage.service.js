'use strict';

/**
 * MinIO Storage Service
 * Đóng gói tất cả thao tác với MinIO: upload stream, presigned URL,
 * xóa object, kiểm tra tồn tại, lấy metadata.
 */

const { PassThrough } = require('stream');
const { getClient, BUCKET_REMOTE_SENSING } = require('../configs/minioClient');

const PRESIGNED_DOWNLOAD_EXPIRE = Number(process.env.MINIO_PRESIGNED_EXPIRE_SECONDS) || 900;
const PRESIGNED_UPLOAD_EXPIRE   = Number(process.env.MINIO_UPLOAD_PRESIGNED_EXPIRE_SECONDS) || 3600;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Tạo object key theo cấu trúc: {year}/{month}/{uuid}/{filename}
 * Ví dụ: "2025/06/550e8400-e29b/landsat8_ndvi_kontum.tif"
 */
const buildObjectKey = (uuid, originalName, prefix = '') => {
    const now   = new Date();
    const year  = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const safe  = originalName.replace(/[^a-zA-Z0-9._\-]/g, '_').toLowerCase();
    const base  = prefix ? `${prefix}/` : '';
    return `${base}${year}/${month}/${uuid}/${safe}`;
};

// ── Core Operations ───────────────────────────────────────────────────────────

/**
 * Upload file lên MinIO qua stream (hỗ trợ file rất lớn, không buffer vào RAM).
 *
 * @param {Object} options
 * @param {ReadableStream} options.stream      - Stream dữ liệu file
 * @param {string}         options.objectKey   - Đường dẫn object trong bucket
 * @param {string}         options.mimeType    - MIME type
 * @param {number}         [options.fileSize]  - Kích thước (bytes), giúp MinIO tối ưu
 * @param {string}         [options.bucket]    - Tên bucket (mặc định: BUCKET_REMOTE_SENSING)
 * @returns {Promise<{etag: string, objectKey: string, bucket: string}>}
 */
const uploadStream = async ({ stream, objectKey, mimeType, fileSize, bucket }) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;

    const metaData = {
        'Content-Type': mimeType || 'application/octet-stream',
    };

    // putObject hỗ trợ stream; truyền fileSize để bật multipart tự động
    const result = await client.putObject(
        bucketName,
        objectKey,
        stream,
        fileSize || undefined,
        metaData,
    );

    return {
        etag:      result.etag,
        objectKey,
        bucket:    bucketName,
    };
};

/**
 * Upload buffer (thumbnail nhỏ, file metadata JSON).
 *
 * @param {Object} options
 * @param {Buffer} options.buffer
 * @param {string} options.objectKey
 * @param {string} options.mimeType
 * @param {string} [options.bucket]
 */
const uploadBuffer = async ({ buffer, objectKey, mimeType, bucket }) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;

    const { Readable } = require('stream');
    const readable = Readable.from(buffer);

    const result = await client.putObject(
        bucketName,
        objectKey,
        readable,
        buffer.length,
        { 'Content-Type': mimeType || 'application/octet-stream' },
    );

    return { etag: result.etag, objectKey, bucket: bucketName };
};

/**
 * Tạo presigned GET URL (download).
 * URL hết hạn sau PRESIGNED_DOWNLOAD_EXPIRE giây (mặc định 15 phút).
 *
 * @param {string} objectKey
 * @param {string} [bucket]
 * @param {number} [expireSeconds]
 * @returns {Promise<{url: string, expiresAt: Date}>}
 */
const getPresignedDownloadUrl = async (objectKey, bucket, expireSeconds) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;
    const expire     = expireSeconds || PRESIGNED_DOWNLOAD_EXPIRE;

    const url = await client.presignedGetObject(bucketName, objectKey, expire);
    const expiresAt = new Date(Date.now() + expire * 1000);

    return { url, expiresAt };
};

/**
 * Tạo presigned PUT URL (client upload trực tiếp lên MinIO).
 *
 * @param {string} objectKey
 * @param {string} [bucket]
 * @param {number} [expireSeconds]
 * @returns {Promise<{url: string, expiresAt: Date, objectKey: string}>}
 */
const getPresignedUploadUrl = async (objectKey, bucket, expireSeconds) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;
    const expire     = expireSeconds || PRESIGNED_UPLOAD_EXPIRE;

    const url = await client.presignedPutObject(bucketName, objectKey, expire);
    const expiresAt = new Date(Date.now() + expire * 1000);

    return { url, expiresAt, objectKey, bucket: bucketName };
};

/**
 * Xóa một object khỏi MinIO.
 *
 * @param {string} objectKey
 * @param {string} [bucket]
 */
const removeObject = async (objectKey, bucket) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;
    await client.removeObject(bucketName, objectKey);
};

/**
 * Xóa nhiều object cùng lúc (dùng khi hard-delete ảnh).
 *
 * @param {string[]} objectKeys
 * @param {string}   [bucket]
 */
const removeObjects = async (objectKeys, bucket) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;

    if (!objectKeys || objectKeys.length === 0) { return; }

    const objectsList = objectKeys.map((name) => ({ name }));
    await new Promise((resolve, reject) => {
        client.removeObjects(bucketName, objectsList, (err) => {
            if (err) { return reject(err); }
            resolve();
        });
    });
};

/**
 * Kiểm tra object có tồn tại trong MinIO không.
 *
 * @param {string} objectKey
 * @param {string} [bucket]
 * @returns {Promise<boolean>}
 */
const objectExists = async (objectKey, bucket) => {
    try {
        const client     = getClient();
        const bucketName = bucket || BUCKET_REMOTE_SENSING;
        await client.statObject(bucketName, objectKey);
        return true;
    } catch (err) {
        if (err.code === 'NotFound' || err.message?.includes('Not Found')) {
            return false;
        }
        throw err;
    }
};

/**
 * Lấy metadata của object từ MinIO (size, etag, lastModified, contentType).
 *
 * @param {string} objectKey
 * @param {string} [bucket]
 * @returns {Promise<{size: number, etag: string, lastModified: Date, contentType: string, metaData: object}>}
 */
const getObjectMeta = async (objectKey, bucket) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;
    const stat       = await client.statObject(bucketName, objectKey);

    return {
        size:         stat.size,
        etag:         stat.etag,
        lastModified: stat.lastModified,
        contentType:  stat.metaData?.['content-type'] || 'application/octet-stream',
        metaData:     stat.metaData || {},
    };
};

/**
 * Download object về dạng Buffer (dùng cho worker xử lý).
 * CẢNH BÁO: Không dùng với file > vài trăm MB — sẽ gây OOM.
 *
 * @param {string} objectKey
 * @param {string} [bucket]
 * @returns {Promise<Buffer>}
 */
const downloadToBuffer = async (objectKey, bucket) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;

    const stream = await client.getObject(bucketName, objectKey);
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end',  () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
};

/**
 * Lấy object stream (dùng cho streaming download qua Express).
 *
 * @param {string} objectKey
 * @param {string} [bucket]
 * @returns {Promise<ReadableStream>}
 */
const getObjectStream = async (objectKey, bucket) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;
    return client.getObject(bucketName, objectKey);
};

module.exports = {
    buildObjectKey,
    uploadStream,
    uploadBuffer,
    getPresignedDownloadUrl,
    getPresignedUploadUrl,
    removeObject,
    removeObjects,
    objectExists,
    getObjectMeta,
    downloadToBuffer,
    getObjectStream,
    BUCKET_REMOTE_SENSING,
};
