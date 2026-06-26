'use strict';

/**
 * Remote Sensing Repository
 * Raw SQL queries cho PostgreSQL/PostGIS.
 * Tất cả query đều idempotent và parameterized (chống SQL injection).
 */

const db = require('../configs/database');   // pool pg hiện tại của dự án
const { versionCondition } = require('../utils/optimistic-lock.util');

// ══════════════════════════════════════════════════════════════════════════════
//  IMAGES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Tạo ảnh mới.
 * @param {Object} data
 * @returns {Promise<Object>} — bản ghi vừa tạo
 */
const createImage = async (data) => {
    const {
        name, description, satellite, image_type, acquisition_date, acquisition_time,
        bbox, province_code, district_code, location_name,
        cloud_percent, resolution_m, epsg_code, band_count, nodata_value,
        is_public = false, is_featured = false, extra_metadata = {},
        created_by,
    } = data;

    // Chuyển bbox array [minLon,minLat,maxLon,maxLat] → WKT POLYGON
    let bboxWkt = null;
    if (Array.isArray(bbox) && bbox.length === 4) {
        const [minX, minY, maxX, maxY] = bbox;
        bboxWkt = `POLYGON((${minX} ${minY}, ${maxX} ${minY}, ${maxX} ${maxY}, ${minX} ${maxY}, ${minX} ${minY}))`;
    } else if (typeof bbox === 'string' && bbox.startsWith('POLYGON')) {
        bboxWkt = bbox;
    }

    const sql = `
        INSERT INTO raster.remote_sensing_images (
            name, description, satellite, image_type, acquisition_date, acquisition_time,
            bbox, province_code, district_code, location_name,
            cloud_percent, resolution_m, epsg_code, band_count, nodata_value,
            is_public, is_featured, extra_metadata,
            status, created_by
        ) VALUES (
            $1, $2, $3::raster.satellite_type, $4::raster.image_type, $5, $6,
            ST_GeomFromText($7, 4326), $8, $9, $10,
            $11, $12, $13, $14, $15,
            $16, $17, $18::jsonb,
            'pending', $19
        )
        RETURNING
            id, uuid, name, description, satellite, image_type,
            acquisition_date, acquisition_time,
            ST_AsGeoJSON(bbox)::jsonb AS bbox_geojson,
            province_code, district_code, location_name,
            cloud_percent, resolution_m, epsg_code, band_count, nodata_value,
            is_public, is_featured, extra_metadata,
            status, created_by, created_at, updated_at;
    `;

    const { rows } = await db.query(sql, [
        name, description || null, satellite, image_type, acquisition_date, acquisition_time || null,
        bboxWkt,
        province_code || null, district_code || null, location_name || null,
        cloud_percent ?? null, resolution_m ?? null, epsg_code || 4326, band_count || null, nodata_value ?? null,
        is_public, is_featured, JSON.stringify(extra_metadata),
        created_by || null,
    ]);
    return rows[0];
};

/**
 * Lấy danh sách ảnh với phân trang và bộ lọc.
 */
const findImages = async (filters = {}) => {
    const {
        keyword, satellite, image_type, status, is_public,
        province_code, district_code, year, date_from, date_to,
        bbox, page = 1, limit = 20, sort_by = 'acquisition_date', sort_order = 'desc',
        viewer_role,
    } = filters;

    const conditions = ['i.deleted_at IS NULL'];
    const params     = [];
    let   pi         = 1; // param index

    // Public-only cho citizen
    if (viewer_role === 'citizen') {
        conditions.push('i.is_public = true');
    } else if (is_public !== undefined) {
        conditions.push(`i.is_public = $${pi++}`);
        params.push(is_public);
    }

    if (keyword) {
        conditions.push(`(i.name ILIKE $${pi} OR i.description ILIKE $${pi} OR i.location_name ILIKE $${pi})`);
        params.push(`%${keyword}%`);
        pi++;
    }
    if (satellite) {
        conditions.push(`i.satellite = $${pi++}::raster.satellite_type`);
        params.push(satellite);
    }
    if (image_type) {
        conditions.push(`i.image_type = $${pi++}::raster.image_type`);
        params.push(image_type);
    }
    if (status) {
        conditions.push(`i.status = $${pi++}::raster.processing_status`);
        params.push(status);
    }
    if (province_code) {
        conditions.push(`i.province_code = $${pi++}`);
        params.push(province_code);
    }
    if (district_code) {
        conditions.push(`i.district_code = $${pi++}`);
        params.push(district_code);
    }
    if (year) {
        conditions.push(`EXTRACT(YEAR FROM i.acquisition_date) = $${pi++}`);
        params.push(year);
    }
    if (date_from) {
        conditions.push(`i.acquisition_date >= $${pi++}`);
        params.push(date_from);
    }
    if (date_to) {
        conditions.push(`i.acquisition_date <= $${pi++}`);
        params.push(date_to);
    }
    // Bounding box spatial filter
    if (bbox) {
        const [minX, minY, maxX, maxY] = bbox.split(',').map(Number);
        conditions.push(`i.bbox && ST_MakeEnvelope($${pi}, $${pi+1}, $${pi+2}, $${pi+3}, 4326)`);
        params.push(minX, minY, maxX, maxY);
        pi += 4;
    }

    const SORTABLE = {
        acquisition_date: 'i.acquisition_date',
        created_at:       'i.created_at',
        name:             'i.name',
        cloud_percent:    'i.cloud_percent',
    };
    const sortCol = SORTABLE[sort_by] || 'i.acquisition_date';
    const sortDir = sort_order === 'asc' ? 'ASC' : 'DESC';

    const offset = (page - 1) * limit;

    const sql = `
        SELECT
            i.id, i.uuid, i.name, i.description, i.satellite, i.image_type,
            i.acquisition_date, i.cloud_percent, i.resolution_m,
            i.province_code, i.location_name,
            i.is_public, i.is_featured, i.status,
            ST_AsGeoJSON(i.bbox)::jsonb AS bbox_geojson,
            -- Thumbnail URL (file role = thumbnail, is_active)
            (
                SELECT f.object_key
                FROM   raster.remote_sensing_files f
                WHERE  f.image_id = i.id AND f.file_role = 'thumbnail' AND f.is_active = true
                LIMIT  1
            ) AS thumbnail_object_key,
            i.created_at, i.updated_at,
            COUNT(*) OVER() AS total_count
        FROM  raster.remote_sensing_images i
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${sortCol} ${sortDir}
        LIMIT  $${pi++} OFFSET $${pi++}
    `;
    params.push(limit, offset);

    const { rows } = await db.query(sql, params);
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    return { rows, total, page, limit };
};

/**
 * Tìm ảnh theo ID hoặc UUID.
 */
const findImageById = async (idOrUuid) => {
    const isUuid = /^[0-9a-f-]{36}$/i.test(String(idOrUuid));
    const sql = `
        SELECT
            i.*,
            ST_AsGeoJSON(i.bbox)::jsonb AS bbox_geojson,
            u.full_name AS created_by_name
        FROM  raster.remote_sensing_images i
        LEFT JOIN auth.users u ON u.id = i.created_by
        WHERE i.deleted_at IS NULL
          AND ${isUuid ? 'i.uuid = $1::uuid' : 'i.id = $1::bigint'}
        LIMIT 1
    `;
    const { rows } = await db.query(sql, [idOrUuid]);
    return rows[0] || null;
};

/**
 * Cập nhật metadata ảnh.
 */
const updateImage = async (id, data, updatedBy) => {
    const FIELD_MAP = {
        name: 'name', description: 'description',
        satellite: 'satellite::raster.satellite_type', image_type: 'image_type::raster.image_type',
        acquisition_date: 'acquisition_date', acquisition_time: 'acquisition_time',
        province_code: 'province_code', district_code: 'district_code', location_name: 'location_name',
        cloud_percent: 'cloud_percent', resolution_m: 'resolution_m',
        epsg_code: 'epsg_code', band_count: 'band_count', nodata_value: 'nodata_value',
        is_public: 'is_public', is_featured: 'is_featured',
        status: 'status::raster.processing_status',
    };

    const sets   = ['updated_at = NOW()'];
    const params = [];
    let   pi     = 1;

    sets.push(`updated_by = $${pi++}`);
    params.push(updatedBy || null);

    for (const [key, col] of Object.entries(FIELD_MAP)) {
        if (key in data) {
            const castMatch = col.match(/^(\w+)::([\w.]+)$/);
            if (castMatch) {
                sets.push(`${castMatch[1]} = $${pi++}::${castMatch[2]}`);
            } else {
                sets.push(`${col} = $${pi++}`);
            }
            params.push(data[key]);
        }
    }

    // Xử lý bbox riêng
    if (data.bbox !== undefined) {
        let bboxWkt = null;
        if (Array.isArray(data.bbox) && data.bbox.length === 4) {
            const [minX, minY, maxX, maxY] = data.bbox;
            bboxWkt = `POLYGON((${minX} ${minY}, ${maxX} ${minY}, ${maxX} ${maxY}, ${minX} ${maxY}, ${minX} ${minY}))`;
        } else if (typeof data.bbox === 'string') {
            bboxWkt = data.bbox;
        }
        sets.push(`bbox = ST_GeomFromText($${pi++}, 4326)`);
        params.push(bboxWkt);
    }

    // Xử lý extra_metadata (merge)
    if (data.extra_metadata !== undefined) {
        sets.push(`extra_metadata = extra_metadata || $${pi++}::jsonb`);
        params.push(JSON.stringify(data.extra_metadata));
    }

    params.push(id); // id luôn ở cuối
    // Optimistic locking (optional): chỉ áp khi client gửi expectedUpdatedAt.
    let lockSql = '';
    if (data.expectedUpdatedAt) {
        params.push(data.expectedUpdatedAt);
        lockSql = versionCondition(params.length);
    }
    const sql = `
        UPDATE raster.remote_sensing_images
        SET    ${sets.join(', ')}
        WHERE  id = $${pi} AND deleted_at IS NULL${lockSql}
        RETURNING id, uuid, name, satellite, image_type, status, updated_at,
                  ST_AsGeoJSON(bbox)::jsonb AS bbox_geojson
    `;
    const { rows } = await db.query(sql, params);
    return rows[0] || null;
};

/**
 * Soft delete ảnh.
 */
const softDeleteImage = async (id, deletedBy) => {
    const sql = `
        UPDATE raster.remote_sensing_images
        SET    deleted_at = NOW(), deleted_by = $2
        WHERE  id = $1 AND deleted_at IS NULL
        RETURNING id, uuid, name
    `;
    const { rows } = await db.query(sql, [id, deletedBy || null]);
    return rows[0] || null;
};

// ══════════════════════════════════════════════════════════════════════════════
//  FILES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Tạo file record mới (sau khi upload lên MinIO thành công).
 */
const createFile = async (data) => {
    const {
        image_id, bucket_name, object_key, original_name,
        file_role = 'primary', mime_type, file_size_bytes,
        width_px, height_px, checksum_md5, extra_info = {}, uploaded_by,
    } = data;

    const sql = `
        INSERT INTO raster.remote_sensing_files (
            image_id, bucket_name, object_key, original_name,
            file_role, mime_type, file_size_bytes,
            width_px, height_px, checksum_md5, extra_info, uploaded_by
        ) VALUES ($1, $2, $3, $4, $5::raster.file_role, $6, $7, $8, $9, $10, $11::jsonb, $12)
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        image_id, bucket_name, object_key, original_name,
        file_role, mime_type || null, file_size_bytes || null,
        width_px || null, height_px || null, checksum_md5 || null,
        JSON.stringify(extra_info), uploaded_by || null,
    ]);
    return rows[0];
};

/**
 * Lấy tất cả files của 1 ảnh.
 */
const findFilesByImageId = async (imageId) => {
    const sql = `
        SELECT *
        FROM   raster.remote_sensing_files
        WHERE  image_id = $1 AND is_active = true
        ORDER BY
            CASE file_role
                WHEN 'primary'   THEN 1
                WHEN 'cog'       THEN 2
                WHEN 'thumbnail' THEN 3
                WHEN 'metadata'  THEN 4
                ELSE 5
            END
    `;
    const { rows } = await db.query(sql, [imageId]);
    return rows;
};

/**
 * Lấy 1 file theo ID.
 */
const findFileById = async (fileId) => {
    const { rows } = await db.query(
        'SELECT * FROM raster.remote_sensing_files WHERE id = $1 AND is_active = true',
        [fileId],
    );
    return rows[0] || null;
};

/**
 * Đánh dấu file là inactive (soft delete file).
 */
const deactivateFile = async (fileId) => {
    await db.query(
        'UPDATE raster.remote_sensing_files SET is_active = false, updated_at = NOW() WHERE id = $1',
        [fileId],
    );
};

/**
 * Lấy tất cả object_key của ảnh (để xóa MinIO).
 */
const getObjectKeysByImageId = async (imageId) => {
    const { rows } = await db.query(
        'SELECT id, bucket_name, object_key FROM raster.remote_sensing_files WHERE image_id = $1',
        [imageId],
    );
    return rows;
};

// ══════════════════════════════════════════════════════════════════════════════
//  PROCESSING JOBS
// ══════════════════════════════════════════════════════════════════════════════

const createJob = async ({ image_id, file_id, job_type = 'full_pipeline', priority = 5 }) => {
    const sql = `
        INSERT INTO raster.remote_sensing_processing_jobs
            (image_id, file_id, job_type, priority)
        VALUES ($1, $2, $3::raster.job_type, $4)
        RETURNING *
    `;
    const { rows } = await db.query(sql, [image_id, file_id || null, job_type, priority]);
    return rows[0];
};

const findPendingJobs = async (limit = 5) => {
    const sql = `
        SELECT j.*, i.name AS image_name
        FROM   raster.remote_sensing_processing_jobs j
        JOIN   raster.remote_sensing_images          i ON i.id = j.image_id
        WHERE  j.status = 'pending'
          AND  j.attempt_count < j.max_attempts
          AND  (j.next_retry_at IS NULL OR j.next_retry_at <= NOW())
        ORDER BY j.priority ASC, j.created_at ASC
        LIMIT  $1
    `;
    const { rows } = await db.query(sql, [limit]);
    return rows;
};

const updateJobStatus = async (jobId, status, extra = {}) => {
    const { result_data, error_message, error_stack, progress, worker_id } = extra;
    const sql = `
        UPDATE raster.remote_sensing_processing_jobs
        SET
            status        = $2::raster.processing_status,
            progress      = COALESCE($3, progress),
            started_at    = CASE WHEN $2 = 'processing' AND started_at IS NULL THEN NOW() ELSE started_at END,
            completed_at  = CASE WHEN $2 IN ('completed','failed','cancelled')  THEN NOW() ELSE completed_at END,
            attempt_count = attempt_count + CASE WHEN $2 = 'processing' THEN 1 ELSE 0 END,
            result_data   = COALESCE($4::jsonb, result_data),
            error_message = $5,
            error_stack   = $6,
            worker_id     = COALESCE($7, worker_id),
            updated_at    = NOW()
        WHERE  id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        jobId, status, progress ?? null,
        result_data ? JSON.stringify(result_data) : null,
        error_message || null, error_stack || null,
        worker_id || null,
    ]);
    return rows[0];
};

// ══════════════════════════════════════════════════════════════════════════════
//  STATISTICS
// ══════════════════════════════════════════════════════════════════════════════

const upsertStatistics = async (imageId, fileId, stats) => {
    const sql = `
        INSERT INTO raster.remote_sensing_statistics
            (image_id, file_id, band_index, band_name, min_value, max_value, mean_value, std_value, valid_pixels, total_pixels, histogram)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        ON CONFLICT (image_id, band_index)
        DO UPDATE SET
            min_value    = EXCLUDED.min_value,
            max_value    = EXCLUDED.max_value,
            mean_value   = EXCLUDED.mean_value,
            std_value    = EXCLUDED.std_value,
            valid_pixels = EXCLUDED.valid_pixels,
            total_pixels = EXCLUDED.total_pixels,
            histogram    = EXCLUDED.histogram,
            computed_at  = NOW()
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        imageId, fileId || null,
        stats.band_index || 1, stats.band_name || null,
        stats.min ?? null, stats.max ?? null,
        stats.mean ?? null, stats.std ?? null,
        stats.valid_pixels ?? null, stats.total_pixels ?? null,
        stats.histogram ? JSON.stringify(stats.histogram) : null,
    ]);
    return rows[0];
};

const findStatsByImageId = async (imageId) => {
    const { rows } = await db.query(
        'SELECT * FROM raster.remote_sensing_statistics WHERE image_id = $1 ORDER BY band_index',
        [imageId],
    );
    return rows;
};

// ══════════════════════════════════════════════════════════════════════════════
//  DOWNLOAD LOGS
// ══════════════════════════════════════════════════════════════════════════════

const logDownload = async ({ image_id, file_id, user_id, ip_address, user_agent, expires_at }) => {
    const sql = `
        INSERT INTO raster.remote_sensing_download_logs
            (image_id, file_id, user_id, ip_address, user_agent, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
    `;
    const { rows } = await db.query(sql, [
        image_id, file_id || null, user_id || null,
        ip_address || null, user_agent || null, expires_at || null,
    ]);
    return rows[0];
};

// ══════════════════════════════════════════════════════════════════════════════
//  LAYERS (cho WebGIS)
// ══════════════════════════════════════════════════════════════════════════════

const findLayersForWebGIS = async (filters = {}) => {
    const { satellite, image_type, province_code, bbox, limit = 100 } = filters;
    const conditions = [
        "i.deleted_at IS NULL",
        "i.status = 'completed'",
        "i.is_public = true",
    ];
    const params = [];
    let pi = 1;

    if (satellite) { conditions.push(`i.satellite = $${pi++}::raster.satellite_type`); params.push(satellite); }
    if (image_type) { conditions.push(`i.image_type = $${pi++}::raster.image_type`); params.push(image_type); }
    if (province_code) { conditions.push(`i.province_code = $${pi++}`); params.push(province_code); }
    if (bbox) {
        const [minX, minY, maxX, maxY] = bbox.split(',').map(Number);
        conditions.push(`i.bbox && ST_MakeEnvelope($${pi}, $${pi+1}, $${pi+2}, $${pi+3}, 4326)`);
        params.push(minX, minY, maxX, maxY);
        pi += 4;
    }

    const sql = `
        SELECT
            i.id, i.uuid, i.name, i.satellite, i.image_type,
            i.acquisition_date, i.cloud_percent, i.resolution_m,
            i.province_code, i.location_name,
            ST_AsGeoJSON(i.bbox)::jsonb AS bbox_geojson,
            ST_Extent(i.bbox) OVER() AS extent,
            -- COG object key (ưu tiên cog, fallback primary)
            COALESCE(
                (SELECT object_key FROM raster.remote_sensing_files WHERE image_id = i.id AND file_role = 'cog'     AND is_active = true LIMIT 1),
                (SELECT object_key FROM raster.remote_sensing_files WHERE image_id = i.id AND file_role = 'primary' AND is_active = true LIMIT 1)
            ) AS cog_object_key,
            (SELECT object_key FROM raster.remote_sensing_files WHERE image_id = i.id AND file_role = 'thumbnail' AND is_active = true LIMIT 1) AS thumbnail_object_key,
            i.extra_metadata
        FROM  raster.remote_sensing_images i
        WHERE ${conditions.join(' AND ')}
        ORDER BY i.acquisition_date DESC
        LIMIT  $${pi}
    `;
    params.push(limit);
    const { rows } = await db.query(sql, params);
    return rows;
};

module.exports = {
    // Images
    createImage, findImages, findImageById, updateImage, softDeleteImage,
    // Files
    createFile, findFilesByImageId, findFileById, deactivateFile, getObjectKeysByImageId,
    // Jobs
    createJob, findPendingJobs, updateJobStatus,
    // Statistics
    upsertStatistics, findStatsByImageId,
    // Logs
    logDownload,
    // WebGIS
    findLayersForWebGIS,
};
