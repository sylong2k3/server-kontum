const {
    DEFAULT_ALLOWED_PARAMS,
    assertGeoserverConfigured,
} = require('../configs/geoserver');
const { t } = require('./i18n.util');

// ─── Custom Error ─────────────────────────────────────────────────────────────

class GeoServerError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'GeoServerError';
        this.status = status;
        this.responseBody = body;
    }
}

const normalizeBaseUrl = (url) => url.replace(/\/+$/, '');

const authHeader = () => {
    const { user, password } = assertGeoserverConfigured();
    return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
};


const requestGeoserver = async (path, options = {}) => {
    const config = assertGeoserverConfigured();
    const url = `${normalizeBaseUrl(config.url)}${path}`;
    const timeoutMs = parseInt(process.env.GEOSERVER_TIMEOUT_MS, 10) || 15_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                Authorization: authHeader(),
                ...(options.headers || {}),
            },
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new GeoServerError(
                `GeoServer ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
                res.status,
                body.slice(0, 1000)
            );
        }

        return res;
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new GeoServerError(`GeoServer timeout sau ${timeoutMs}ms`, 504, '');
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
};

const publishVectorLayer = async (layer) => {
    const config = assertGeoserverConfigured();
    const workspace = config.workspace;
    const datastore = layer.geoserver_store || config.datastore;
    const featureName = layer.table_name;
    const srs = `EPSG:${layer.epsg_code || 4326}`;

    await requestGeoserver(
        `/rest/workspaces/${workspace}/datastores/${datastore}/featuretypes`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                featureType: {
                    name: featureName,
                    nativeName: featureName,
                    srs,
                    enabled: layer.is_active !== false,
                    title: layer.name_vi || featureName,
                },
            }),
        }
    );

    return `${workspace}:${featureName}`;
};
const isAlreadyExistsError = (err) =>
    err instanceof GeoServerError
    && /already exists/i.test(`${err.message} ${err.responseBody || ''}`);

const publishRasterLayer = async (layer, lang = 'vi') => {
    const config = assertGeoserverConfigured();
    const workspace = config.workspace;
    const storeName = layer.geoserver_store || layer.table_name;
    const sourceUrl = layer.source_url;

    if (!sourceUrl) {
        throw new Error(t('geoserver_raster_source_required', lang));
    }

    // Tạo CoverageStore — store đã tồn tại (retry sau lần publish dở dang) thì bỏ qua
    try {
        await requestGeoserver(
            `/rest/workspaces/${workspace}/coveragestores`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    coverageStore: {
                        name: storeName,
                        type: 'GeoTIFF',
                        enabled: true,
                        workspace: { name: workspace },
                        url: sourceUrl.startsWith('file://') ? sourceUrl : `file://${sourceUrl}`,
                    },
                }),
            }
        );
    } catch (err) {
        if (!isAlreadyExistsError(err)) { throw err; }
    }

    // Publish coverage từ store
    try {
        await requestGeoserver(
            `/rest/workspaces/${workspace}/coveragestores/${storeName}/coverages`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    coverage: {
                        name: storeName,
                        title: layer.name_vi || storeName,
                        enabled: true,
                    },
                }),
            }
        );
    } catch (err) {
        if (!isAlreadyExistsError(err)) { throw err; }
    }

    return `${workspace}:${storeName}`;
};
const publishTimelapseLayer = async (layer, lang = 'vi') => {
    const config = assertGeoserverConfigured();
    const workspace = config.workspace;
    const storeName = layer.geoserver_store || layer.table_name;
    const mosaicPath = layer.mosaic_path;

    if (!mosaicPath) {
        throw new Error(t('geoserver_timelapse_mosaic_required', lang));
    }

    const fileUrl = mosaicPath.startsWith('file://') ? mosaicPath : `file://${mosaicPath}`;

    // configure=first&coverageName= bắt buộc để GeoServer tạo Coverage ngay lần
    // đầu (không có 2 tham số này, store được tạo nhưng không có coverage nào
    // được publish — xem docs/guides/13-geoserver-postgis-setup-guide.md §4.2).
    await requestGeoserver(
        `/rest/workspaces/${workspace}/coveragestores/${storeName}/external.imagemosaic`
            + `?configure=first&coverageName=${encodeURIComponent(storeName)}`,
        {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain' },
            body: fileUrl,
        }
    );

    return `${workspace}:${storeName}`;
};

/**
 * Bật time dimension cho 1 coverage ImageMosaic đã tồn tại — tương đương thao
 * tác tay "Layers → Dimensions → bật Time" mô tả ở docs/guides/13 §4.2 Bước 3,
 * nhưng làm qua REST để tự động hoá lúc tạo mosaic lần đầu.
 *
 * @param {string} coverageStore  — tên CoverageStore (== tên Coverage, quy ước dùng chung trong app)
 * @param {object} [opts]
 * @param {'LIST'|'CONTINUOUS'|'DISCRETE_INTERVAL'} [opts.presentation]
 * @param {'MINIMUM'|'MAXIMUM'|'NEAREST'|'FIXED'} [opts.defaultStrategy]
 */
const enableTimeDimension = async (coverageStore, { presentation = 'LIST', defaultStrategy = 'MAXIMUM' } = {}) => {
    const config = assertGeoserverConfigured();
    await requestGeoserver(
        `/rest/workspaces/${config.workspace}/coveragestores/${coverageStore}/coverages/${coverageStore}`,
        {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                coverage: {
                    metadata: {
                        entry: [{
                            '@key': 'time',
                            dimensionInfo: {
                                enabled: true,
                                presentation,
                                units: 'ISO8601',
                                defaultValue: { strategy: defaultStrategy },
                            },
                        }],
                    },
                },
            }),
        }
    );
};

const encodeLayerName = (geoserverLayerName) => String(geoserverLayerName)
    .split(':')
    .map((part) => encodeURIComponent(part))
    .join(':');

const unpublishLayer = async (geoserverLayerName) => {
    await requestGeoserver(
        `/rest/layers/${encodeLayerName(geoserverLayerName)}?recurse=true`,
        { method: 'DELETE' }
    );
};

const setLayerEnabled = async (geoserverLayerName, enabled) => {
    await requestGeoserver(
        `/rest/layers/${encodeLayerName(geoserverLayerName)}`,
        {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ layer: { enabled } }),
        }
    );
};


const truncateGwcLayer = async (geoserverLayerName, format = 'image/png', zoomStart = 0, zoomStop = 16) => {
    await requestGeoserver(
        `/gwc/rest/seed/${encodeURIComponent(geoserverLayerName)}.json`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seedRequest: {
                    name: geoserverLayerName,
                    type: 'truncate',
                    zoomStart,
                    zoomStop,
                    format,
                    // GeoWebCache 1.29+ unboxes this field without a null guard.
                    // Omitting it makes truncate return HTTP 500 even though the
                    // coverage itself was published successfully.
                    threadCount: 1,
                },
            }),
        }
    );
};

/**
 * Publish 1 GeoTIFF nằm trên MinIO/S3 qua CoverageStore type `S3GeoTiff`.
 * Yêu cầu extension `gs-s3-geotiff` đã cài trên GeoServer + file properties
 * `.s3.properties` trong GEOSERVER_DATA_DIR trỏ endpoint MinIO nếu không phải AWS.
 *
 * @param {object} args
 * @param {string} args.storeName    — tên CoverageStore + Coverage (thường trùng)
 * @param {string} args.s3Bucket
 * @param {string} args.s3Key
 * @param {string} args.title
 * @param {boolean} [args.enabled]
 * @returns {Promise<string>} — 'workspace:storeName'
 */
const publishS3GeoTiffLayer = async ({
    storeName, s3Bucket, s3Key, title, enabled = true,
}) => {
    const config    = assertGeoserverConfigured();
    const workspace = config.workspace;
    const s3Url     = `s3://${s3Bucket}/${s3Key}`;
    const t0        = Date.now();
    const dbg       = (process.env.RASTER_INGEST_DEBUG === 'true'
                        || process.env.NODE_ENV === 'development')
        ? (msg) => console.debug(`[GEOSERVER-S3] ${msg}`) : () => {};

    dbg(`publish store=${storeName} ws=${workspace} url=${s3Url}`);

    // 1. CoverageStore. Upsert: POST tạo mới, nếu đã tồn tại thì PUT cập nhật
    // URL — cần thiết cho re-ingest (URL S3 có thể trỏ file khác) — nếu bỏ qua,
    // GeoServer sẽ serve raster cũ mãi mãi.
    const storeBody = JSON.stringify({
        coverageStore: {
            name: storeName,
            type: 'S3GeoTiff',
            enabled,
            workspace: { name: workspace },
            url: s3Url,
        },
    });

    try {
        await requestGeoserver(
            `/rest/workspaces/${workspace}/coveragestores`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: storeBody,
            }
        );
        dbg(`store CREATED (POST)`);
    } catch (err) {
        if (!isAlreadyExistsError(err)) {
            console.error(`[GEOSERVER-S3] store CREATE FAILED store=${storeName} status=${err.status}: ${err.message}`);
            throw err;
        }
        // Đã tồn tại → PUT cập nhật URL. GeoServer trả 200 kể cả khi URL trùng.
        dbg(`store exists → PUT update URL`);
        await requestGeoserver(
            `/rest/workspaces/${workspace}/coveragestores/${storeName}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: storeBody,
            }
        );
        dbg(`store URL UPDATED (PUT)`);
    }

    // 2. Coverage.
    try {
        await requestGeoserver(
            `/rest/workspaces/${workspace}/coveragestores/${storeName}/coverages`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    coverage: {
                        name:  storeName,
                        title: title || storeName,
                        enabled,
                    },
                }),
            }
        );
        dbg(`coverage CREATED`);
    } catch (err) {
        if (!isAlreadyExistsError(err)) {
            console.error(`[GEOSERVER-S3] coverage CREATE FAILED store=${storeName} status=${err.status}: ${err.message}`);
            throw err;
        }
        dbg(`coverage already exists — kept`);
    }

    const layerName = `${workspace}:${storeName}`;
    dbg(`done → ${layerName} (${Date.now() - t0}ms)`);
    return layerName;
};

/**
 * Publish 1 GeoTIFF nằm trên filesystem (đã copy vào GEOSERVER_DATA_DIR
 * hoặc path GeoServer đọc được) qua CoverageStore type `GeoTIFF` — dùng cho
 * môi trường không có community extension `gs-s3-geotiff` (VD GeoServer 3.0.0
 * chưa port module).
 *
 * @param {object}  args
 * @param {string}  args.storeName
 * @param {string}  args.filePath   — path tuyệt đối tới .tif trên đĩa
 * @param {string}  args.title
 * @param {boolean} [args.enabled]
 * @returns {Promise<string>} — 'workspace:storeName'
 */
const publishFsGeoTiffLayer = async ({
    storeName, filePath, title, enabled = true,
}) => {
    const config    = assertGeoserverConfigured();
    const workspace = config.workspace;
    // pathToFileURL xử lý drive letter + backslash trên Windows đúng chuẩn
    // (file:///C:/... thay vì file:C:\... — cái sau GeoServer từng parse sai).
    const { pathToFileURL } = require('url');
    const fileUrl   = pathToFileURL(filePath).href;
    const t0        = Date.now();
    const dbg       = (process.env.RASTER_INGEST_DEBUG === 'true'
                        || process.env.NODE_ENV === 'development')
        ? (msg) => console.debug(`[GEOSERVER-FS] ${msg}`) : () => {};

    dbg(`publish store=${storeName} ws=${workspace} url=${fileUrl}`);

    const storeBody = JSON.stringify({
        coverageStore: {
            name: storeName,
            type: 'GeoTIFF',
            enabled,
            workspace: { name: workspace },
            url: fileUrl,
        },
    });

    try {
        await requestGeoserver(
            `/rest/workspaces/${workspace}/coveragestores`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: storeBody },
        );
        dbg('store CREATED (POST)');
    } catch (err) {
        if (!isAlreadyExistsError(err)) {
            console.error(`[GEOSERVER-FS] store CREATE FAILED store=${storeName} status=${err.status}: ${err.message}`);
            throw err;
        }
        dbg('store exists → PUT update URL');
        await requestGeoserver(
            `/rest/workspaces/${workspace}/coveragestores/${storeName}`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: storeBody },
        );
        dbg('store URL UPDATED (PUT)');
    }

    try {
        await requestGeoserver(
            `/rest/workspaces/${workspace}/coveragestores/${storeName}/coverages`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    coverage: { name: storeName, title: title || storeName, enabled },
                }),
            },
        );
        dbg('coverage CREATED');
    } catch (err) {
        if (!isAlreadyExistsError(err)) {
            console.error(`[GEOSERVER-FS] coverage CREATE FAILED store=${storeName} status=${err.status}: ${err.message}`);
            throw err;
        }
        dbg('coverage already exists — kept');
    }

    const layerName = `${workspace}:${storeName}`;
    dbg(`done → ${layerName} (${Date.now() - t0}ms)`);
    return layerName;
};

const harvestGeoTiff = async (coverageStore, tifPath) => {
    const config = assertGeoserverConfigured();
    const fileUrl = tifPath.startsWith('file://') ? tifPath : `file://${tifPath}`;

    await requestGeoserver(
        `/rest/workspaces/${config.workspace}/coveragestores/${coverageStore}/external.imagemosaic`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: fileUrl,
        }
    );
};



const healthCheck = async () => {
    try {
        assertGeoserverConfigured();
        await requestGeoserver('/rest/workspaces.json');
        return true;
    } catch {
        return false;
    }
};


module.exports = {
    GeoServerError,
    DEFAULT_ALLOWED_PARAMS,
    publishVectorLayer,
    publishRasterLayer,
    publishS3GeoTiffLayer,
    publishFsGeoTiffLayer,
    publishTimelapseLayer,
    enableTimeDimension,
    unpublishLayer,
    setLayerEnabled,
    truncateGwcLayer,
    harvestGeoTiff,
    // Health
    healthCheck,
};
