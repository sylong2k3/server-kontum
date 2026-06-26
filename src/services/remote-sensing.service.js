const { Readable }   = require('stream');
const repo    = require('../repositories/remote-sensing.repository');
const minio   = require('./minio.service');
const { Api404Error, Api403Error, Api400Error } = require('../core/error.response');

const uploadImage = async ({ metadata, rasterFile, thumbnailFile, metaJsonFile, user }) => {
    const imageUuid    = uuidv4();
    const uploadedKeys = [];

    const rasterObjectKey = minio.buildObjectKey(imageUuid, rasterFile.originalname, 'raster');
    const rasterStream    = Readable.from(rasterFile.buffer);

    let rasterEtag;
    try {
        const result = await minio.uploadStream({
            stream:    rasterStream,
            objectKey: rasterObjectKey,
            mimeType:  rasterFile.mimetype || 'image/tiff',
            fileSize:  rasterFile.size,
        });
        rasterEtag = result.etag;
        uploadedKeys.push({ objectKey: rasterObjectKey, bucket: minio.BUCKET_REMOTE_SENSING });
    } catch (err) {
        throw new Error(`Upload file GeoTIFF lên MinIO thất bại: ${err.message}`);
    }

    let thumbnailObjectKey = null;
    if (thumbnailFile) {
        thumbnailObjectKey = minio.buildObjectKey(imageUuid, thumbnailFile.originalname, 'thumbnails');
        try {
            await minio.uploadBuffer({
                buffer:    thumbnailFile.buffer,
                objectKey: thumbnailObjectKey,
                mimeType:  thumbnailFile.mimetype || 'image/png',
            });
            uploadedKeys.push({ objectKey: thumbnailObjectKey, bucket: minio.BUCKET_REMOTE_SENSING });
        } catch (err) {
            console.warn('[RemoteSensing] Upload thumbnail thất bại:', err.message);
            thumbnailObjectKey = null;
        }
    }
    let metaJsonObjectKey = null;
    if (metaJsonFile) {
        metaJsonObjectKey = minio.buildObjectKey(imageUuid, metaJsonFile.originalname, 'metadata');
        try {
            await minio.uploadBuffer({
                buffer:    metaJsonFile.buffer,
                objectKey: metaJsonObjectKey,
                mimeType:  'application/json',
            });
            uploadedKeys.push({ objectKey: metaJsonObjectKey, bucket: minio.BUCKET_REMOTE_SENSING });
        } catch (err) {
            console.warn('[RemoteSensing] Upload metadata JSON thất bại:', err.message);
            metaJsonObjectKey = null;
        }
    }

    let imageRecord, rasterFileRecord, job;
    try {
        // 4a. Tạo image record
        imageRecord = await repo.createImage({
            ...metadata,
            created_by: user.id,
        });

        rasterFileRecord = await repo.createFile({
            image_id:        imageRecord.id,
            bucket_name:     minio.BUCKET_REMOTE_SENSING,
            object_key:      rasterObjectKey,
            original_name:   rasterFile.originalname,
            file_role:       'primary',
            mime_type:       rasterFile.mimetype || 'image/tiff',
            file_size_bytes: rasterFile.size,
            extra_info:      { etag: rasterEtag },
            uploaded_by:     user.id,
        });
        if (thumbnailObjectKey) {
            await repo.createFile({
                image_id:        imageRecord.id,
                bucket_name:     minio.BUCKET_REMOTE_SENSING,
                object_key:      thumbnailObjectKey,
                original_name:   thumbnailFile.originalname,
                file_role:       'thumbnail',
                mime_type:       thumbnailFile.mimetype || 'image/png',
                file_size_bytes: thumbnailFile.size,
                uploaded_by:     user.id,
            });
        }

        if (metaJsonObjectKey) {
            await repo.createFile({
                image_id:        imageRecord.id,
                bucket_name:     minio.BUCKET_REMOTE_SENSING,
                object_key:      metaJsonObjectKey,
                original_name:   metaJsonFile.originalname,
                file_role:       'metadata',
                mime_type:       'application/json',
                file_size_bytes: metaJsonFile.size,
                uploaded_by:     user.id,
            });
        }

        // 4e. Tạo processing job
        job = await repo.createJob({
            image_id: imageRecord.id,
            file_id:  rasterFileRecord.id,
            job_type: 'full_pipeline',
            priority: 5,
        });

    } catch (err) {
        // ⚠ Rollback: xóa tất cả objects đã upload lên MinIO
        console.error('[RemoteSensing] DB insert thất bại, rollback MinIO:', err.message);
        for (const { objectKey, bucket } of uploadedKeys) {
            try {
                await minio.removeObject(objectKey, bucket);
                console.info(`[RemoteSensing] Đã rollback object: ${objectKey}`);
            } catch (rollbackErr) {
                console.error(`[RemoteSensing] Không thể xóa object ${objectKey}:`, rollbackErr.message);
            }
        }
        throw err;
    }

    return { image: imageRecord, file: rasterFileRecord, job };
};

// ══════════════════════════════════════════════════════════════════════════════
//  PRESIGNED UPLOAD URL (client upload thẳng lên MinIO)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Tạo presigned PUT URL để client upload file lớn trực tiếp lên MinIO.
 * Phù hợp khi file > 500MB (tránh qua Node.js server).
 */
const getPresignedUploadUrl = async ({ fileName }) => {
    const imageUuid   = uuidv4();
    const objectKey   = minio.buildObjectKey(imageUuid, fileName, 'raster');
    const result      = await minio.getPresignedUploadUrl(objectKey);
    return { ...result, uuid: imageUuid };
};

// ══════════════════════════════════════════════════════════════════════════════
//  LIST / DETAIL
// ══════════════════════════════════════════════════════════════════════════════

const listImages = async (filters, user) => {
    // Thêm viewer_role để filter is_public cho citizen
    const viewer_role = user?.role || 'citizen';
    const result = await repo.findImages({ ...filters, viewer_role });

    // Không attach presigned URL trong list (tránh N+1 và giới hạn URL)
    return result;
};

const getImageDetail = async (idOrUuid, user) => {
    const image = await repo.findImageById(idOrUuid);
    if (!image) { throw new Api404Error('Không tìm thấy ảnh viễn thám.'); }

    // Kiểm tra quyền xem
    if (!image.is_public) {
        if (!user) { throw new Api403Error('Ảnh này không công khai. Vui lòng đăng nhập.'); }
        const role = user.role;
        if (role === 'citizen') { throw new Api403Error('Bạn không có quyền xem ảnh này.'); }
    }

    // Lấy danh sách files
    const files = await repo.findFilesByImageId(image.id);

    // Lấy statistics nếu có
    const statistics = await repo.findStatsByImageId(image.id);

    // Tạo presigned URL cho thumbnail (nếu có)
    let thumbnailUrl = null;
    const thumbFile  = files.find((f) => f.file_role === 'thumbnail');
    if (thumbFile) {
        try {
            const { url } = await minio.getPresignedDownloadUrl(thumbFile.object_key, thumbFile.bucket_name);
            thumbnailUrl = url;
        } catch { /* ignore */ }
    }

    return { image, files, statistics, thumbnailUrl };
};

// ══════════════════════════════════════════════════════════════════════════════
//  UPDATE
// ══════════════════════════════════════════════════════════════════════════════

const updateImage = async (idOrUuid, data, user) => {
    const existing = await repo.findImageById(idOrUuid);
    if (!existing) { throw new Api404Error('Không tìm thấy ảnh viễn thám.'); }

    // Chỉ owner hoặc admin mới được sửa
    const isOwner = existing.created_by === user.id;
    const isAdmin = ['system_admin', 'so_nnmt'].includes(user.role);
    if (!isOwner && !isAdmin) {
        throw new Api403Error('Bạn không có quyền cập nhật ảnh này.');
    }

    return repo.updateImage(existing.id, data, user.id);
};

// ══════════════════════════════════════════════════════════════════════════════
//  DELETE
// ══════════════════════════════════════════════════════════════════════════════

const deleteImage = async (idOrUuid, { hardDelete = false, user }) => {
    const existing = await repo.findImageById(idOrUuid);
    if (!existing) { throw new Api404Error('Không tìm thấy ảnh viễn thám.'); }

    // Chỉ owner hoặc admin mới được xóa
    const isOwner = existing.created_by === user.id;
    const isAdmin = ['system_admin'].includes(user.role);
    if (!isOwner && !isAdmin) {
        throw new Api403Error('Bạn không có quyền xóa ảnh này.');
    }

    // Hard delete: xóa objects trên MinIO
    if (hardDelete) {
        const fileRecords = await repo.getObjectKeysByImageId(existing.id);
        const objectKeys  = fileRecords.map((f) => f.object_key);
        if (objectKeys.length > 0) {
            try {
                await minio.removeObjects(objectKeys, minio.BUCKET_REMOTE_SENSING);
                console.info(`[RemoteSensing] Đã xóa ${objectKeys.length} objects trên MinIO.`);
            } catch (err) {
                console.error('[RemoteSensing] Lỗi xóa MinIO objects:', err.message);
            }
        }
    }

    // Soft delete DB record
    return repo.softDeleteImage(existing.id, user.id);
};

// ══════════════════════════════════════════════════════════════════════════════
//  DOWNLOAD
// ══════════════════════════════════════════════════════════════════════════════

const getDownloadUrl = async (idOrUuid, { fileId, user, ip, userAgent }) => {
    const image = await repo.findImageById(idOrUuid);
    if (!image) { throw new Api404Error('Không tìm thấy ảnh viễn thám.'); }

    // Kiểm tra quyền download
    if (!image.is_public) {
        if (!user) { throw new Api403Error('Vui lòng đăng nhập để tải ảnh.'); }
        const role = user.role;
        const perms = user.role_permissions?.remote_sensing || {};
        if (role !== 'system_admin' && !perms.download) {
            throw new Api403Error('Bạn không có quyền tải ảnh này.');
        }
    }

    // Tìm file cần download
    let targetFile;
    if (fileId) {
        targetFile = await repo.findFileById(fileId);
        if (!targetFile || targetFile.image_id !== image.id) {
            throw new Api404Error('File không tồn tại trong ảnh này.');
        }
    } else {
        const files = await repo.findFilesByImageId(image.id);
        // Ưu tiên COG > primary
        targetFile = files.find((f) => f.file_role === 'cog')
                  || files.find((f) => f.file_role === 'primary')
                  || files[0];
    }
    if (!targetFile) { throw new Api404Error('Không tìm thấy file để tải.'); }

    // Tạo presigned URL 15 phút
    const expireSeconds = Number(process.env.MINIO_PRESIGNED_EXPIRE_SECONDS) || 900;
    const { url, expiresAt } = await minio.getPresignedDownloadUrl(
        targetFile.object_key, targetFile.bucket_name, expireSeconds,
    );

    // Ghi log download
    await repo.logDownload({
        image_id:   image.id,
        file_id:    targetFile.id,
        user_id:    user?.id,
        ip_address: ip,
        user_agent: userAgent,
        expires_at: expiresAt,
    });

    return {
        downloadUrl:   url,
        expiresAt,
        fileName:      targetFile.original_name,
        fileSizeBytes: targetFile.file_size_bytes,
        mimeType:      targetFile.mime_type,
    };
};

// ══════════════════════════════════════════════════════════════════════════════
//  COG URL / WEBGIS
// ══════════════════════════════════════════════════════════════════════════════

const getCogUrl = async (idOrUuid, user) => {
    const image = await repo.findImageById(idOrUuid);
    if (!image) { throw new Api404Error('Không tìm thấy ảnh viễn thám.'); }

    if (!image.is_public && !user) {
        throw new Api403Error('Ảnh này không công khai.');
    }

    const files     = await repo.findFilesByImageId(image.id);
    const cogFile   = files.find((f) => f.file_role === 'cog')
                   || files.find((f) => f.file_role === 'primary');

    if (!cogFile) { throw new Api404Error('Chưa có file COG cho ảnh này.'); }

    // Presigned URL cho COG — expire 15 phút
    const expireSeconds = Number(process.env.MINIO_PRESIGNED_EXPIRE_SECONDS) || 900;
    const { url, expiresAt } = await minio.getPresignedDownloadUrl(
        cogFile.object_key, cogFile.bucket_name, expireSeconds,
    );

    return {
        cogUrl:    url,
        expiresAt,
        fileRole:  cogFile.file_role,
        bboxGeojson: image.bbox_geojson,
        epsgCode:  image.epsg_code,
        bandCount: image.band_count,
        imageType: image.image_type,
        satellite: image.satellite,
        metadata:  image.extra_metadata,
        // Hướng dẫn frontend
        webgisHint: {
            openLayers: 'new GeoTIFF({ sources: [{ url: cogUrl }] })',
            mapboxGL:   'type: "raster", tiles: [cogUrl]',
            leaflet:    'L.tileLayer(cogUrl, { tms: false })',
        },
    };
};

const getLayersForWebGIS = async (filters) => {
    const rows = await repo.findLayersForWebGIS(filters);

    // Gắn presigned URL cho từng layer (batch)
    const expireSeconds = Number(process.env.MINIO_PRESIGNED_EXPIRE_SECONDS) || 900;
    const layers = await Promise.all(
        rows.map(async (row) => {
            let cogUrl       = null;
            let thumbnailUrl = null;

            if (row.cog_object_key) {
                try {
                    const { url } = await minio.getPresignedDownloadUrl(
                        row.cog_object_key, minio.BUCKET_REMOTE_SENSING, expireSeconds,
                    );
                    cogUrl = url;
                } catch { /* ignore */ }
            }
            if (row.thumbnail_object_key) {
                try {
                    const { url } = await minio.getPresignedDownloadUrl(
                        row.thumbnail_object_key, minio.BUCKET_REMOTE_SENSING, expireSeconds,
                    );
                    thumbnailUrl = url;
                } catch { /* ignore */ }
            }

            return {
                id:             row.id,
                uuid:           row.uuid,
                name:           row.name,
                satellite:      row.satellite,
                imageType:      row.image_type,
                acquisitionDate: row.acquisition_date,
                cloudPercent:   row.cloud_percent,
                resolutionM:    row.resolution_m,
                provinceCode:   row.province_code,
                locationName:   row.location_name,
                bbox:           row.bbox_geojson,
                cogUrl,
                thumbnailUrl,
                expiresAt:      new Date(Date.now() + expireSeconds * 1000),
                extraMetadata:  row.extra_metadata,
            };
        }),
    );

    return layers;
};

// ══════════════════════════════════════════════════════════════════════════════
//  TRIGGER JOB
// ══════════════════════════════════════════════════════════════════════════════

const triggerProcessingJob = async (idOrUuid, { job_type, priority, user }) => {
    const image = await repo.findImageById(idOrUuid);
    if (!image) { throw new Api404Error('Không tìm thấy ảnh viễn thám.'); }

    const files       = await repo.findFilesByImageId(image.id);
    const primaryFile = files.find((f) => f.file_role === 'primary');

    const job = await repo.createJob({
        image_id: image.id,
        file_id:  primaryFile?.id,
        job_type: job_type || 'full_pipeline',
        priority: priority || 5,
    });

    return { job, image: { id: image.id, uuid: image.uuid, name: image.name } };
};

// ══════════════════════════════════════════════════════════════════════════════
//  STATISTICS
// ══════════════════════════════════════════════════════════════════════════════

const getStatistics = async (idOrUuid, user) => {
    const image = await repo.findImageById(idOrUuid);
    if (!image) { throw new Api404Error('Không tìm thấy ảnh viễn thám.'); }

    if (!image.is_public && !user) {
        throw new Api403Error('Vui lòng đăng nhập để xem thống kê.');
    }

    const stats = await repo.findStatsByImageId(image.id);
    return { image: { id: image.id, name: image.name, imageType: image.image_type }, statistics: stats };
};

module.exports = {
    uploadImage,
    getPresignedUploadUrl,
    listImages,
    getImageDetail,
    updateImage,
    deleteImage,
    getDownloadUrl,
    getCogUrl,
    getLayersForWebGIS,
    triggerProcessingJob,
    getStatistics,
};
