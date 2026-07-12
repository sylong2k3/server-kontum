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

    await requestGeoserver(
        `/rest/workspaces/${workspace}/coveragestores/${storeName}/external.imagemosaic`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: fileUrl,
        }
    );

    return `${workspace}:${storeName}`;
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
                },
            }),
        }
    );
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
    publishTimelapseLayer,
    unpublishLayer,
    setLayerEnabled,
    truncateGwcLayer,
    harvestGeoTiff,
    // Health
    healthCheck,
};
