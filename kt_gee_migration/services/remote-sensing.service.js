const fs   = require('fs');
const path = require('path');
const { Readable }   = require('stream');
const { pipeline }   = require('stream/promises');
const db        = require('../configs/database');
const repo      = require('../repositories/remote-sensing.repository');
const layerRepo = require('../repositories/map-layer.repository');
const minio     = require('./minio.service');
const geoserver = require('../utils/geoserver.client');
const { Api404Error, Api403Error, Api400Error, Api409Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');
const { isTiffBuffer, TIFF_MAGIC_LENGTH } = require('../utils/geotiff.util');
const { v4: uuidv4 } = require('uuid');

// Giới hạn kích thước cho ảnh raster nhận qua presigned PUT (mặc định 2GB).
// Vượt ngưỡng này bị từ chối tường minh thay vì để worker OOM khi xử lý.
const RASTER_PRESIGNED_MAX_BYTES = Number(process.env.RASTER_MAX_FILE_SIZE_MB || 2048) * 1024 * 1024;

const uploadImage = async ({ metadata, rasterFile, thumbnailFile, metaJsonFile, user, lang }) => {
    const imageUuid    = uuidv4();
    const uploadedKeys = [];

    // Xác thực nội dung thật sự là GeoTIFF (không tin MIME/extension do client khai)
    if (!isTiffBuffer(rasterFile.buffer)) {
        throw new Api400Error(t('remote_sensing_not_geotiff', lang), ['NOT_GEOTIFF']);
    }

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
        throw new Error(t('remote_sensing_minio_upload_failed', lang, { msg: err.message }));
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
            console.warn(t('remote_sensing_thumbnail_upload_failed_log', lang), err.message);
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
            console.warn(t('remote_sensing_metadata_upload_failed_log', lang), err.message);
            metaJsonObjectKey = null;
        }
    }

    let imageRecord, rasterFileRecord, job;
    const client = await db.pool.connect();
    try {
        // Toàn bộ insert (image + files + job) nằm trong 1 transaction —
        // lỗi giữa chừng sẽ ROLLBACK, tránh để lại image "mồ côi" không có file/job.
        await client.query('BEGIN');

        // 4a. Tạo image record
        imageRecord = await repo.createImage({
            ...metadata,
            created_by: user.id,
        }, client);

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
        }, client);
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
            }, client);
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
            }, client);
        }

        // 4e. Tạo processing job
        job = await repo.createJob({
            image_id: imageRecord.id,
            file_id:  rasterFileRecord.id,
            job_type: 'full_pipeline',
            priority: 5,
        }, client);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* connection có thể đã hỏng */ });
        // ⚠ DB đã rollback → xóa tất cả objects đã upload lên MinIO cho khớp
        console.error(t('remote_sensing_db_insert_failed_rollback', lang), err.message);
        for (const { objectKey, bucket } of uploadedKeys) {
            try {
                await minio.removeObject(objectKey, bucket);
                console.info(t('remote_sensing_rollback_object_done', lang, { objectKey }));
            } catch (rollbackErr) {
                console.error(t('remote_sensing_rollback_object_failed', lang, { objectKey }), rollbackErr.message);
            }
        }
        throw err;
    } finally {
        client.release();
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
const getPresignedUploadUrl = async ({ fileName, user, lang }) => {
    const imageUuid   = uuidv4();
    const objectKey   = minio.buildObjectKey(imageUuid, fileName, 'raster');
    const result      = await minio.getPresignedUploadUrl(objectKey);
    return { ...result, uuid: imageUuid };
};

// Key hợp lệ phải đúng dạng do getPresignedUploadUrl cấp: raster/YYYY/MM/<uuid>/<tên file>.
// uuid ngẫu nhiên chỉ trả về cho chính người xin URL → ràng buộc này chặn client
// commit key trỏ tới object của người khác hoặc namespace khác (thumbnails/, metadata/…).
const RASTER_OBJECT_KEY_RE =
    /^raster\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z0-9._-]+$/i;

const commitPresignedUpload = async ({ data, user, lang }) => {
    // `bucket` do client gửi bị bỏ qua — luôn dùng bucket viễn thám cố định.
    const { object_key, bucket: _ignoredBucket, original_name, mime_type, ...metadata } = data;
    const bucketName = minio.BUCKET_REMOTE_SENSING;

    if (!RASTER_OBJECT_KEY_RE.test(object_key)) {
        throw new Api400Error(t('remote_sensing_upload_object_key_invalid', lang), ['INVALID_OBJECT_KEY']);
    }

    const exists = await minio.objectExists(object_key, bucketName);
    if (!exists) {
        throw new Api400Error(t('remote_sensing_upload_object_missing', lang), ['OBJECT_NOT_FOUND']);
    }

    // Xác thực object client vừa PUT thật sự là GeoTIFF (đọc vài byte đầu, không tải nguyên file).
    // Đây là chốt chặn cho presigned PUT — vốn không ràng buộc được Content-Type phía MinIO.
    const head = await minio.getObjectHead(object_key, bucketName, TIFF_MAGIC_LENGTH);
    if (!isTiffBuffer(head)) {
        throw new Api400Error(t('remote_sensing_not_geotiff', lang), ['NOT_GEOTIFF']);
    }

    const objectMeta = await minio.getObjectMeta(object_key, bucketName);

    if (objectMeta.size > RASTER_PRESIGNED_MAX_BYTES) {
        await minio.removeObject(object_key, bucketName).catch(() => { /* best-effort cleanup */ });
        const maxMB = Math.round(RASTER_PRESIGNED_MAX_BYTES / (1024 * 1024));
        throw new Api400Error(t('remote_sensing_file_too_large', lang, { maxMB }), ['FILE_TOO_LARGE']);
    }

    let imageRecord, rasterFileRecord, job;
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        imageRecord = await repo.createImage({
            ...metadata,
            created_by: user.id,
        }, client);

        rasterFileRecord = await repo.createFile({
            image_id:        imageRecord.id,
            bucket_name:     bucketName,
            object_key,
            original_name:   original_name || path.basename(object_key),
            file_role:       'primary',
            mime_type:       mime_type || objectMeta.contentType || 'image/tiff',
            file_size_bytes: objectMeta.size,
            extra_info:      { etag: objectMeta.etag, uploaded_via: 'presigned_put' },
            uploaded_by:     user.id,
        }, client);

        job = await repo.createJob({
            image_id: imageRecord.id,
            file_id:  rasterFileRecord.id,
            job_type: 'full_pipeline',
            priority: 5,
        }, client);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* connection có thể đã hỏng */ });
        throw err;
    } finally {
        client.release();
    }

    return { image: imageRecord, file: rasterFileRecord, job };
};

// ══════════════════════════════════════════════════════════════════════════════
//  LIST / DETAIL
// ══════════════════════════════════════════════════════════════════════════════

const listImages = async (filters, user, lang) => {
    // Thêm viewer_role để filter is_public cho citizen
    const viewer_role = user?.role || 'citizen';
    const result = await repo.findImages({ ...filters, viewer_role });

    // Không attach presigned URL trong list (tránh N+1 và giới hạn URL)
    return result;
};

const getImageDetail = async (idOrUuid, user, lang) => {
    const image = await repo.findImageById(idOrUuid);
    if (!image) { throw new Api404Error(t('remote_sensing_not_found', lang)); }

    // Kiểm tra quyền xem
    if (!image.is_public) {
        if (!user) { throw new Api403Error(t('remote_sensing_not_public_login', lang)); }
        const role = user.role;
        if (role === 'citizen') { throw new Api403Error(t('remote_sensing_no_view_permission', lang)); }
    }

    // Lấy files và statistics song song
    const [files, statistics] = await Promise.all([
        repo.findFilesByImageId(image.id),
        repo.findStatsByImageId(image.id),
    ]);

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

const updateImage = async (idOrUuid, data, user, lang) => {
    const existing = await repo.findImageById(idOrUuid);
    if (!existing) { throw new Api404Error(t('remote_sensing_not_found', lang)); }

    // Chỉ owner hoặc admin mới được sửa
    const isOwner = existing.created_by === user.id;
    const isAdmin = ['system_admin', 'so_nnmt'].includes(user.role);
    if (!isOwner && !isAdmin) {
        throw new Api403Error(t('remote_sensing_no_update_permission', lang));
    }

    const updated = await repo.updateImage(existing.id, data, user.id);
    if (!updated) {
        // existing đã xác nhận tồn tại ở trên → null nghĩa là expectedUpdatedAt lệch (conflict)
        if (data.expectedUpdatedAt) { throw new Api409Error(t('optimistic_lock_conflict', lang)); }
        throw new Api404Error(t('remote_sensing_not_found', lang));
    }
    return updated;
};

// ══════════════════════════════════════════════════════════════════════════════
//  DELETE
// ══════════════════════════════════════════════════════════════════════════════

const deleteImage = async (idOrUuid, { hardDelete = false, user, lang }) => {
    const existing = await repo.findImageById(idOrUuid);
    if (!existing) { throw new Api404Error(t('remote_sensing_not_found', lang)); }

    // Chỉ owner hoặc admin mới được xóa
    const isOwner = existing.created_by === user.id;
    const isAdmin = ['system_admin'].includes(user.role);
    if (!isOwner && !isAdmin) {
        throw new Api403Error(t('remote_sensing_no_delete_permission', lang));
    }

    // Lấy danh sách object keys trước khi soft delete (chỉ active files)
    const fileRecords = hardDelete ? await repo.getObjectKeysByImageId(existing.id) : [];

    // Soft delete DB record trước — đảm bảo DB nhất quán dù MinIO xóa lỗi
    const deleted = await repo.softDeleteImage(existing.id, user.id);

    // Hard delete: xóa objects trên MinIO sau khi DB đã commit
    if (hardDelete && fileRecords.length > 0) {
        const objectKeys = fileRecords.map((f) => f.object_key);
        try {
            await minio.removeObjects(objectKeys, minio.BUCKET_REMOTE_SENSING);
            console.info(t('remote_sensing_minio_objects_deleted', lang, { count: objectKeys.length }));
        } catch (err) {
            console.error(t('remote_sensing_minio_delete_failed', lang), err.message);
        }
    }

    return deleted;
};

// ══════════════════════════════════════════════════════════════════════════════
//  DOWNLOAD
// ══════════════════════════════════════════════════════════════════════════════

const getDownloadUrl = async (idOrUuid, { fileId, user, ip, userAgent, lang }) => {
    const image = await repo.findImageById(idOrUuid);
    if (!image) { throw new Api404Error(t('remote_sensing_not_found', lang)); }

    // Kiểm tra quyền download
    if (!image.is_public) {
        if (!user) { throw new Api403Error(t('remote_sensing_no_download_login', lang)); }
        const role = user.role;
        const perms = user.role_permissions?.remote_sensing || {};
        if (role !== 'system_admin' && !perms.download) {
            throw new Api403Error(t('remote_sensing_no_download_permission', lang));
        }
    }

    // Tìm file cần download
    let targetFile;
    if (fileId) {
        targetFile = await repo.findFileById(fileId);
        if (!targetFile || targetFile.image_id !== image.id) {
            throw new Api404Error(t('remote_sensing_file_not_found', lang));
        }
    } else {
        const files = await repo.findFilesByImageId(image.id);
        // Ưu tiên COG > primary
        targetFile = files.find((f) => f.file_role === 'cog')
                  || files.find((f) => f.file_role === 'primary')
                  || files[0];
    }
    if (!targetFile) { throw new Api404Error(t('remote_sensing_download_file_not_found', lang)); }

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

const getCogUrl = async (idOrUuid, user, lang) => {
    const image = await repo.findImageById(idOrUuid);
    if (!image) { throw new Api404Error(t('remote_sensing_not_found', lang)); }

    if (!image.is_public && !user) {
        throw new Api403Error(t('remote_sensing_not_public', lang));
    }

    const files     = await repo.findFilesByImageId(image.id);
    const cogFile   = files.find((f) => f.file_role === 'cog')
                   || files.find((f) => f.file_role === 'primary');

    if (!cogFile) { throw new Api404Error(t('remote_sensing_no_cog', lang)); }

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

const getLayersForWebGIS = async (filters, lang) => {
    const rows = await repo.findLayersForWebGIS(filters);

    // Gắn presigned URL cho từng layer (batch)
    const expireSeconds = Number(process.env.MINIO_PRESIGNED_EXPIRE_SECONDS) || 900;
    const layers = await Promise.all(
        rows.map(async (row) => {
            let cogUrl       = null;
            let thumbnailUrl = null;

            const [cogResult, thumbResult] = await Promise.allSettled([
                row.cog_object_key
                    ? minio.getPresignedDownloadUrl(row.cog_object_key, minio.BUCKET_REMOTE_SENSING, expireSeconds)
                    : Promise.resolve(null),
                row.thumbnail_object_key
                    ? minio.getPresignedDownloadUrl(row.thumbnail_object_key, minio.BUCKET_REMOTE_SENSING, expireSeconds)
                    : Promise.resolve(null),
            ]);
            if (cogResult.status === 'fulfilled' && cogResult.value) { cogUrl = cogResult.value.url; }
            if (thumbResult.status === 'fulfilled' && thumbResult.value) { thumbnailUrl = thumbResult.value.url; }

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
//  PUBLISH LÊN GEOSERVER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Publish ảnh trong kho viễn thám (MinIO) lên GeoServer để hiển thị qua WMS:
 *   1. Lấy file raster (ưu tiên COG > primary) từ MinIO, stream ra GEOSERVER_DATA_DIR
 *   2. Upsert vào gis.layer_registry (liên kết remote_sensing_image_id)
 *   3. Tạo CoverageStore + Coverage trên GeoServer
 *
 * Publish lại cùng ảnh (hoặc đổi file) sẽ ghi đè file trên đĩa và xóa tile cache.
 */
const publishImageToGeoServer = async (idOrUuid, options, user, lang) => {
    const image = await repo.findImageById(idOrUuid);
    if (!image) { throw new Api404Error(t('remote_sensing_not_found', lang)); }

    const files      = await repo.findFilesByImageId(image.id);
    const rasterFile = files.find((f) => f.file_role === 'cog')
                    || files.find((f) => f.file_role === 'primary');
    if (!rasterFile) { throw new Api404Error(t('remote_sensing_publish_no_raster', lang)); }

    const destDir = process.env.GEOSERVER_DATA_DIR;
    if (!destDir) { throw new Api400Error(t('map_geo_raster_dir_missing', lang), ['RASTER_DIR_MISSING']); }
    fs.mkdirSync(destDir, { recursive: true });

    // Tên file cố định theo code → publish lại chỉ ghi đè, GeoServer store không đổi URL
    const code     = options.code || `rs_img_${image.id}`;
    const destFile = path.join(destDir, `${code}.tif`);
    const tmpFile  = `${destFile}.tmp`;

    // Ghi ra file tạm rồi rename (atomic) — tránh GeoServer đọc phải file dở nếu
    // stream lỗi giữa chừng; dọn file tạm khi thất bại.
    try {
        const objectStream = await minio.getObjectStream(rasterFile.object_key, rasterFile.bucket_name);
        await pipeline(objectStream, fs.createWriteStream(tmpFile));
        fs.renameSync(tmpFile, destFile);
    } catch (err) {
        try { fs.unlinkSync(tmpFile); } catch { /* file tạm chưa tạo hoặc đã dọn */ }
        throw err;
    }

    const layerRow = await layerRepo.upsertLayerByCode(null, {
        code,
        name_vi:        options.name_vi || image.name,
        description_vi: options.description_vi || image.description || null,
        table_name:     code,
        geometry_type:  'RASTER',
        epsg_code:      image.epsg_code || 4326,
        category:       options.category || 'remote_sensing',
        layer_kind:     'overlay',
        layer_group:    options.layer_group || null,
        data_year:      options.data_year
            || (image.acquisition_date ? new Date(image.acquisition_date).getFullYear() : null),
        source_dataset: 'remote_sensing',
        is_active:      true,
        is_public:      options.is_public ?? image.is_public ?? false,
        is_editable:    false,
        source_url:     `file://${destFile}`,
        remote_sensing_image_id: image.id,
        userId:         user?.id || null,
    });

    // Layer đã publish trước đó → file vừa được ghi đè, chỉ cần xóa tile cache
    if (layerRow.geoserver_layer) {
        try {
            await geoserver.truncateGwcLayer(layerRow.geoserver_layer);
        } catch { /* GWC chưa có cache cho layer này — bỏ qua */ }
        return { layer: layerRow, geoserver_layer: layerRow.geoserver_layer, republished: true };
    }

    const geoserverLayerName = await geoserver.publishRasterLayer(layerRow, lang);

    // markPublished tách khỏi publish bằng lời gọi mạng nên không thể gói chung 1 DB
    // transaction. Nếu ghi DB lỗi, gỡ layer vừa tạo trên GeoServer (compensating) để
    // hai bên không lệch nhau; lần publish lại sẽ tạo lại sạch sẽ.
    let published;
    try {
        published = await layerRepo.markPublished(null, {
            code:           layerRow.code,
            geoserverLayer: geoserverLayerName,
            geoserverStore: code,
            updatedBy:      user?.id || null,
        });
    } catch (markErr) {
        try { await geoserver.unpublishLayer(geoserverLayerName); } catch { /* best-effort */ }
        throw markErr;
    }

    return { layer: published || layerRow, geoserver_layer: geoserverLayerName, republished: false };
};

// ══════════════════════════════════════════════════════════════════════════════
//  TRIGGER JOB
// ══════════════════════════════════════════════════════════════════════════════

const triggerProcessingJob = async (idOrUuid, { job_type, priority, user, lang }) => {
    const image = await repo.findImageById(idOrUuid);
    if (!image) { throw new Api404Error(t('remote_sensing_not_found', lang)); }

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

const getStatistics = async (idOrUuid, user, lang) => {
    const image = await repo.findImageById(idOrUuid);
    if (!image) { throw new Api404Error(t('remote_sensing_not_found', lang)); }

    if (!image.is_public && !user) {
        throw new Api403Error(t('remote_sensing_no_stats_login', lang));
    }

    const stats = await repo.findStatsByImageId(image.id);
    const statistics = stats.map((s) => ({
        ...s,
        histogram: s.histogram || { buckets: [], counts: [] },
    }));

    return {
        image: { id: image.id, name: image.name, imageType: image.image_type },
        statistics,
        charts: {
            histograms: statistics.map((s) => ({
                bandIndex: s.band_index,
                bandName:  s.band_name || `Band ${s.band_index}`,
                labels:    s.histogram?.buckets || [],
                values:    s.histogram?.counts || [],
                type:      'bar',
                title:     `Histogram - ${s.band_name || `Band ${s.band_index}`}`,
            })),
        },
    };
};

module.exports = {
    uploadImage,
    getPresignedUploadUrl,
    commitPresignedUpload,
    listImages,
    getImageDetail,
    updateImage,
    deleteImage,
    getDownloadUrl,
    getCogUrl,
    getLayersForWebGIS,
    publishImageToGeoServer,
    triggerProcessingJob,
    getStatistics,
};
