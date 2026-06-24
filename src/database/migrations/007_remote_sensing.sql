-- ============================================================================
-- Migration 007: REMOTE SENSING — Quản lý dữ liệu ảnh viễn thám
-- Schema: raster (tách biệt khỏi auth, gis, fire, cms, field)
-- Storage: File raster lớn lưu trên MinIO; metadata + spatial lưu PostgreSQL.
--
-- Bảng:
--   raster.remote_sensing_images         — Metadata ảnh chính
--   raster.remote_sensing_files          — File vật lý trên MinIO
--   raster.remote_sensing_processing_jobs — Hàng đợi xử lý
--   raster.remote_sensing_statistics     — Thống kê band
--   raster.remote_sensing_download_logs  — Log tải file (audit)
--
-- Idempotent: dùng IF NOT EXISTS / OR REPLACE để chạy lại an toàn.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
--  1. SCHEMA
-- ════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS raster;


-- ════════════════════════════════════════════════════════════════════════════
--  2. ENUM TYPES
-- ════════════════════════════════════════════════════════════════════════════

-- Loại vệ tinh thu thập dữ liệu
DO $$ BEGIN
    CREATE TYPE raster.satellite_type AS ENUM (
        'landsat_8',
        'landsat_9',
        'sentinel_1',
        'sentinel_2',
        'sentinel_3',
        'modis',
        'viirs',
        'planet',
        'spot',
        'vnredsat',
        'other'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Loại dữ liệu ảnh / sản phẩm
DO $$ BEGIN
    CREATE TYPE raster.image_type AS ENUM (
        'geotiff_raw',       -- GeoTIFF gốc chưa xử lý
        'cog',               -- Cloud Optimized GeoTIFF
        'ndvi',              -- Normalized Difference Vegetation Index
        'ndwi',              -- Normalized Difference Water Index
        'nbr',               -- Normalized Burn Ratio
        'lst',               -- Land Surface Temperature
        'land_cover',        -- Phân loại lớp phủ đất / rừng
        'forest_cover',      -- Phân loại rừng
        'rgb_composite',     -- Ảnh tổ hợp màu RGB
        'thumbnail',         -- Ảnh thu nhỏ PNG/JPG
        'metadata_json',     -- File metadata JSON
        'other'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Trạng thái xử lý
DO $$ BEGIN
    CREATE TYPE raster.processing_status AS ENUM (
        'pending',      -- Vừa upload, chờ xử lý
        'processing',   -- Đang xử lý (COG, thumbnail, stats)
        'completed',    -- Xử lý xong
        'failed',       -- Xử lý thất bại
        'cancelled'     -- Đã huỷ
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Loại file trong một ảnh
DO $$ BEGIN
    CREATE TYPE raster.file_role AS ENUM (
        'primary',      -- File chính (GeoTIFF gốc)
        'cog',          -- COG output sau xử lý
        'thumbnail',    -- Thumbnail PNG/JPG
        'metadata',     -- JSON metadata
        'auxiliary'     -- File phụ trợ (.ovr, .aux.xml, ...)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Loại job xử lý
DO $$ BEGIN
    CREATE TYPE raster.job_type AS ENUM (
        'convert_cog',      -- Chuyển GeoTIFF → COG (cần GDAL khi có)
        'gen_thumbnail',    -- Tạo thumbnail
        'calc_statistics',  -- Tính thống kê band (min/max/mean/std)
        'full_pipeline'     -- Thực hiện tất cả bước trên
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ════════════════════════════════════════════════════════════════════════════
--  3. raster.remote_sensing_images — Metadata ảnh chính
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS raster.remote_sensing_images (
    -- Khóa chính
    id                  BIGSERIAL PRIMARY KEY,
    uuid                UUID NOT NULL DEFAULT gen_random_uuid(),

    -- Thông tin ảnh
    name                VARCHAR(500) NOT NULL,
    description         TEXT,
    satellite           raster.satellite_type NOT NULL DEFAULT 'other',
    image_type          raster.image_type NOT NULL DEFAULT 'geotiff_raw',
    acquisition_date    DATE NOT NULL,              -- Ngày chụp ảnh
    acquisition_time    TIMETZ,                     -- Giờ chụp (tuỳ chọn)

    -- Vị trí địa lý
    bbox                GEOMETRY(POLYGON, 4326),    -- Bounding box WGS84
    province_code       VARCHAR(20),                -- Mã tỉnh/huyện (KonTum = '62')
    district_code       VARCHAR(20),                -- Mã huyện
    location_name       VARCHAR(255),               -- Tên khu vực (text)

    -- Đặc tính kỹ thuật
    cloud_percent       NUMERIC(5,2) CHECK (cloud_percent BETWEEN 0 AND 100),
    resolution_m        NUMERIC(10,4),              -- Độ phân giải (mét/pixel)
    epsg_code           INT DEFAULT 4326,           -- Hệ toạ độ
    band_count          INT,                        -- Số kênh phổ
    nodata_value        NUMERIC,                    -- Giá trị NoData
    extra_metadata      JSONB NOT NULL DEFAULT '{}', -- Metadata thêm (projection, origin, ...)

    -- Trạng thái
    status              raster.processing_status NOT NULL DEFAULT 'pending',
    is_public           BOOLEAN NOT NULL DEFAULT false,  -- Public/private
    is_featured         BOOLEAN NOT NULL DEFAULT false,  -- Nổi bật trên map

    -- Người dùng / đơn vị
    created_by          BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    updated_by          BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_by          BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,

    -- Soft delete
    deleted_at          TIMESTAMPTZ,

    -- Timestamps
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS uniq_rsi_uuid
    ON raster.remote_sensing_images (uuid)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rsi_satellite
    ON raster.remote_sensing_images (satellite)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rsi_image_type
    ON raster.remote_sensing_images (image_type)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rsi_acquisition_date
    ON raster.remote_sensing_images (acquisition_date DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rsi_province_code
    ON raster.remote_sensing_images (province_code)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rsi_status
    ON raster.remote_sensing_images (status)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rsi_is_public
    ON raster.remote_sensing_images (is_public)
    WHERE deleted_at IS NULL AND is_public = true;

-- Spatial index quan trọng nhất — tìm kiếm theo bbox
CREATE INDEX IF NOT EXISTS idx_rsi_bbox_gist
    ON raster.remote_sensing_images USING GIST (bbox)
    WHERE deleted_at IS NULL AND bbox IS NOT NULL;

-- Composite cho search thường gặp
CREATE INDEX IF NOT EXISTS idx_rsi_composite_search
    ON raster.remote_sensing_images (satellite, image_type, acquisition_date DESC)
    WHERE deleted_at IS NULL;

-- Trigger updated_at
DROP TRIGGER IF EXISTS trigger_rsi_updated_at ON raster.remote_sensing_images;
CREATE TRIGGER trigger_rsi_updated_at
    BEFORE UPDATE ON raster.remote_sensing_images
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();


-- ════════════════════════════════════════════════════════════════════════════
--  4. raster.remote_sensing_files — File vật lý trên MinIO
--     Mỗi ảnh có thể có nhiều file: GeoTIFF gốc, COG, thumbnail, metadata JSON
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS raster.remote_sensing_files (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID NOT NULL DEFAULT gen_random_uuid(),

    image_id        BIGINT NOT NULL
                    REFERENCES raster.remote_sensing_images(id)
                    ON DELETE CASCADE,

    -- Thông tin MinIO
    bucket_name     VARCHAR(255) NOT NULL,          -- Tên bucket MinIO
    object_key      TEXT NOT NULL,                  -- Đường dẫn object trong bucket
    original_name   VARCHAR(500) NOT NULL,          -- Tên file gốc khi upload

    -- Phân loại
    file_role       raster.file_role NOT NULL DEFAULT 'primary',
    mime_type       VARCHAR(127),                   -- MIME type (image/tiff, image/png, ...)

    -- Kích thước và đặc tính
    file_size_bytes BIGINT,                         -- Kích thước bytes
    width_px        INT,                            -- Chiều rộng pixel
    height_px       INT,                            -- Chiều cao pixel
    checksum_md5    VARCHAR(32),                    -- MD5 để verify tính toàn vẹn
    extra_info      JSONB NOT NULL DEFAULT '{}',    -- etag, version, ...

    -- Upload info
    uploaded_by     BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,  -- false = đã bị xóa khỏi MinIO

    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_rsf_bucket_object
    ON raster.remote_sensing_files (bucket_name, object_key);

CREATE INDEX IF NOT EXISTS idx_rsf_image_id
    ON raster.remote_sensing_files (image_id);

CREATE INDEX IF NOT EXISTS idx_rsf_file_role
    ON raster.remote_sensing_files (image_id, file_role)
    WHERE is_active = true;

DROP TRIGGER IF EXISTS trigger_rsf_updated_at ON raster.remote_sensing_files;
CREATE TRIGGER trigger_rsf_updated_at
    BEFORE UPDATE ON raster.remote_sensing_files
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();


-- ════════════════════════════════════════════════════════════════════════════
--  5. raster.remote_sensing_processing_jobs — Hàng đợi xử lý ảnh
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS raster.remote_sensing_processing_jobs (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID NOT NULL DEFAULT gen_random_uuid(),

    image_id        BIGINT NOT NULL
                    REFERENCES raster.remote_sensing_images(id)
                    ON DELETE CASCADE,
    file_id         BIGINT
                    REFERENCES raster.remote_sensing_files(id)
                    ON DELETE SET NULL,

    job_type        raster.job_type NOT NULL DEFAULT 'full_pipeline',
    status          raster.processing_status NOT NULL DEFAULT 'pending',

    -- Tiến trình
    progress        NUMERIC(5,2) DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,

    -- Thông tin thực thi
    worker_id       VARCHAR(100),                   -- ID của worker xử lý
    attempt_count   INT NOT NULL DEFAULT 0,         -- Số lần thử
    max_attempts    INT NOT NULL DEFAULT 3,         -- Tối đa retry
    next_retry_at   TIMESTAMPTZ,

    -- Kết quả / lỗi
    result_data     JSONB DEFAULT '{}',             -- Output paths, stats kết quả
    error_message   TEXT,
    error_stack     TEXT,

    -- Ưu tiên (số nhỏ = ưu tiên cao)
    priority        INT NOT NULL DEFAULT 5,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rspj_pending_priority
    ON raster.remote_sensing_processing_jobs (priority, created_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_rspj_image_id
    ON raster.remote_sensing_processing_jobs (image_id);

CREATE INDEX IF NOT EXISTS idx_rspj_status
    ON raster.remote_sensing_processing_jobs (status, updated_at DESC);

DROP TRIGGER IF EXISTS trigger_rspj_updated_at ON raster.remote_sensing_processing_jobs;
CREATE TRIGGER trigger_rspj_updated_at
    BEFORE UPDATE ON raster.remote_sensing_processing_jobs
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();


-- ════════════════════════════════════════════════════════════════════════════
--  6. raster.remote_sensing_statistics — Thống kê giá trị pixel theo band
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS raster.remote_sensing_statistics (
    id              BIGSERIAL PRIMARY KEY,

    image_id        BIGINT NOT NULL
                    REFERENCES raster.remote_sensing_images(id)
                    ON DELETE CASCADE,
    file_id         BIGINT
                    REFERENCES raster.remote_sensing_files(id)
                    ON DELETE SET NULL,

    -- Thông tin band
    band_index      INT NOT NULL DEFAULT 1,         -- Chỉ số band (1-based)
    band_name       VARCHAR(100),                   -- Tên band (e.g. 'Red', 'NIR', 'NDVI')

    -- Thống kê giá trị pixel
    min_value       NUMERIC,
    max_value       NUMERIC,
    mean_value      NUMERIC,
    std_value       NUMERIC,                        -- Độ lệch chuẩn
    valid_pixels    BIGINT,                         -- Số pixel có dữ liệu hợp lệ
    total_pixels    BIGINT,                         -- Tổng số pixel

    -- Histogram (lưu dưới dạng JSON để linh hoạt)
    histogram       JSONB DEFAULT NULL,             -- { buckets: [], counts: [] }

    computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_rss_image_band
    ON raster.remote_sensing_statistics (image_id, band_index);

CREATE INDEX IF NOT EXISTS idx_rss_image_id
    ON raster.remote_sensing_statistics (image_id);


-- ════════════════════════════════════════════════════════════════════════════
--  7. raster.remote_sensing_download_logs — Audit log tải file
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS raster.remote_sensing_download_logs (
    id              BIGSERIAL PRIMARY KEY,

    image_id        BIGINT NOT NULL
                    REFERENCES raster.remote_sensing_images(id)
                    ON DELETE CASCADE,
    file_id         BIGINT
                    REFERENCES raster.remote_sensing_files(id)
                    ON DELETE SET NULL,

    -- Người tải
    user_id         BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    ip_address      VARCHAR(45),
    user_agent      TEXT,

    -- Presigned URL info
    presigned_url   TEXT,                           -- URL được tạo (có thể lưu hash)
    expires_at      TIMESTAMPTZ,                    -- Thời gian hết hạn URL
    download_type   VARCHAR(50) DEFAULT 'presigned', -- 'presigned' | 'direct' | 'stream'

    -- Trạng thái (để tracking sau nếu cần)
    status          VARCHAR(20) DEFAULT 'issued',   -- 'issued' | 'downloaded' | 'expired'

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rsdl_image_id
    ON raster.remote_sensing_download_logs (image_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rsdl_user_id
    ON raster.remote_sensing_download_logs (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rsdl_created_at
    ON raster.remote_sensing_download_logs (created_at DESC);


-- ════════════════════════════════════════════════════════════════════════════
--  8. Cập nhật RBAC permissions — thêm resource "remote_sensing"
-- ════════════════════════════════════════════════════════════════════════════

-- system_admin: toàn quyền
UPDATE auth.roles
SET permissions = permissions || '{
    "remote_sensing": {
        "read": true,
        "create": true,
        "update": true,
        "delete": true,
        "download": true,
        "process": true,
        "publish": true,
        "manage": true
    }
}'::jsonb
WHERE code = 'system_admin';

-- so_nnmt (department_manager/operator): upload, quản lý dữ liệu đơn vị mình
UPDATE auth.roles
SET permissions = permissions || '{
    "remote_sensing": {
        "read": true,
        "create": true,
        "update": true,
        "update_own": true,
        "delete_own": true,
        "download": true,
        "process": true,
        "publish": true
    }
}'::jsonb
WHERE code = 'so_nnmt';

-- ubnd_tinh (provincial manager): chỉ xem và duyệt
UPDATE auth.roles
SET permissions = permissions || '{
    "remote_sensing": {
        "read": true,
        "download": true
    }
}'::jsonb
WHERE code = 'ubnd_tinh';

-- citizen: chỉ xem dữ liệu public
UPDATE auth.roles
SET permissions = permissions || '{
    "remote_sensing": {
        "read_public": true
    }
}'::jsonb
WHERE code = 'citizen';
