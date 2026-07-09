
const { PassThrough } = require('stream');
const { getClient, BUCKET_REMOTE_SENSING } = require('../configs/minioClient');

const PRESIGNED_DOWNLOAD_EXPIRE = Number(process.env.MINIO_PRESIGNED_EXPIRE_SECONDS) || 900;
const PRESIGNED_UPLOAD_EXPIRE   = Number(process.env.MINIO_UPLOAD_PRESIGNED_EXPIRE_SECONDS) || 3600;

const buildObjectKey = (uuid, originalName, prefix = '') => {
    const now   = new Date();
    const year  = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const safe  = originalName.replace(/[^a-zA-Z0-9._\-]/g, '_').toLowerCase();
    const base  = prefix ? `${prefix}/` : '';
    return `${base}${year}/${month}/${uuid}/${safe}`;
};
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
const getPresignedDownloadUrl = async (objectKey, bucket, expireSeconds) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;
    const expire     = expireSeconds || PRESIGNED_DOWNLOAD_EXPIRE;

    const url = await client.presignedGetObject(bucketName, objectKey, expire);
    const expiresAt = new Date(Date.now() + expire * 1000);

    return { url, expiresAt };
};
const getPresignedUploadUrl = async (objectKey, bucket, expireSeconds) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;
    const expire     = expireSeconds || PRESIGNED_UPLOAD_EXPIRE;

    const url = await client.presignedPutObject(bucketName, objectKey, expire);
    const expiresAt = new Date(Date.now() + expire * 1000);

    return { url, expiresAt, objectKey, bucket: bucketName };
};
const removeObject = async (objectKey, bucket) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;
    await client.removeObject(bucketName, objectKey);
};
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
const getObjectStream = async (objectKey, bucket) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;
    return client.getObject(bucketName, objectKey);
};
/**
 * Đọc `length` byte đầu tiên của object (dùng để kiểm tra magic-byte mà không
 * tải nguyên file). Trả về Buffer có thể ngắn hơn `length` nếu object nhỏ.
 */
const getObjectHead = async (objectKey, bucket, length) => {
    const client     = getClient();
    const bucketName = bucket || BUCKET_REMOTE_SENSING;
    const stream     = await client.getPartialObject(bucketName, objectKey, 0, length);
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data',  (chunk) => chunks.push(chunk));
        stream.on('end',   () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
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
    getObjectHead,
    BUCKET_REMOTE_SENSING,
};
