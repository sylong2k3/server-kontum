'use strict';

/**
 * Shared GEE (Google Earth Engine) satellite utilities.
 *
 * Used by: satellite.service.js, forest-classification.service.js, fire-risk.service.js
 *
 * All functions accept/return EE objects unless noted with "→ JS value".
 */

const fs   = require('fs');
const path = require('path');
const { ee } = require('../configs/gge');

// Default timeout for .evaluate() calls (5 minutes).
const DEFAULT_TIMEOUT_MS = parseInt(process.env.GEE_TIMEOUT_MS, 10) || 5 * 60 * 1000;

// Local Kon Tum province polygon (higher-fidelity than FAO/GAUL).
// Used only as a fallback when the request omits `params.geometry`;
// user-supplied ROIs are always clipped to as-is.
// Override the file path with the KON_TUM_BOUNDARY_GEOJSON env var.
const KON_TUM_BOUNDARY_PATH = process.env.KON_TUM_BOUNDARY_GEOJSON
    || path.resolve(__dirname, '../../data/RanhGioiTinh_Polygon.geojson');

// ── GEE async helpers ─────────────────────────────────────────────────────────

/**
 * Promisify ee object.evaluate(callback).
 * Rejects after timeoutMs to prevent hanging forever.
 * → JS value
 */
function eeEval(eeObject, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`GEE evaluate() timeout after ${timeoutMs}ms`)),
            timeoutMs,
        );
        eeObject.evaluate((result, err) => {
            clearTimeout(timer);
            if (err) reject(new Error(String(err)));
            else resolve(result);
        });
    });
}

/**
 * Get GEE map tile info for display on Leaflet / MapboxGL.
 * Returns { mapId, token, tileUrl } where tileUrl has {z}/{x}/{y} placeholders.
 *
 * Applies eeImage.visualize(vizParams) client-side (returns an RGB ee.Image),
 * then passes that to ee.data.getMapId. This avoids the SDK trying to CSV-encode
 * numeric arrays/values ("csv.split is not a function") when raw viz params are
 * passed to getMapId.
 * → JS value
 */
function getEeMapId(eeImage, vizParams = {}) {
    // If viz params provided, bake them into an RGB image via ee.Image.visualize().
    const visImage = vizParams && Object.keys(vizParams).length > 0
        ? eeImage.visualize(vizParams)
        : eeImage;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('GEE getMapId timeout')),
            DEFAULT_TIMEOUT_MS,
        );
        ee.data.getMapId(
            { image: visImage },
            (mapInfo, err) => {
                clearTimeout(timer);
                if (err) { reject(new Error(String(err))); return; }
                const mapid = mapInfo.mapid || mapInfo.name || '';
                const token = mapInfo.token || '';
                const tileUrl = token
                    ? `https://earthengine.googleapis.com/map/${mapid}/{z}/{x}/{y}?token=${token}`
                    : `https://earthengine.googleapis.com/v1alpha/${mapid}/tiles/{z}/{x}/{y}`;
                resolve({ mapId: mapid, token, tileUrl });
            },
        );
    });
}

// ── Region helpers ────────────────────────────────────────────────────────────

function getKonTumRegion() {
    return ee.FeatureCollection([ee.Feature(getKonTumBoundaryGeometry())]);
}

// Đường dẫn file polygon huyện WGS84 (do người dùng convert từ QGIS: dissolve
// theo CODE_2002 → polygonize → save GeoJSON EPSG:4326). Có thể override qua
// env `KON_TUM_DISTRICTS_GEOJSON`.
const KON_TUM_DISTRICTS_PATH = process.env.KON_TUM_DISTRICTS_GEOJSON
    || path.resolve(__dirname, '../../data/RanhGioiHuyen_WGS84.geojson');

let _cachedDistrictsFC = null;
let _cachedDistrictsSource = null;

/**
 * Districts (huyện) của Kon Tum. Ưu tiên đọc file polygon WGS84 local nếu tồn
 * tại (cấu trúc chuẩn: FeatureCollection Polygon/MultiPolygon EPSG:4326 với
 * thuộc tính CODE_2002, NAME_VN, NAME_EN). Nếu không có file → fallback về
 * FAO/GAUL/2015/level2 (8 huyện cũ, mã ADM2_CODE).
 *
 * Trả về ee.FeatureCollection dùng cho reduceRegions() ở fire-risk +
 * forest-classification. Mỗi feature giữ nguyên geometry để client render.
 */
function getKonTumDistricts() {
    if (_cachedDistrictsFC) return _cachedDistrictsFC;

    if (fs.existsSync(KON_TUM_DISTRICTS_PATH)) {
        try {
            const raw = fs.readFileSync(KON_TUM_DISTRICTS_PATH, 'utf8');
            const doc = JSON.parse(raw);
            if (doc?.type === 'FeatureCollection' && Array.isArray(doc.features) && doc.features.length > 0) {
                const eeFeats = doc.features.map((f) => {
                    const geom = f.geometry;
                    // Chuẩn hoá properties về ADM2_CODE/ADM2_NAME để tương thích
                    // với mapper hiện có (fire-risk.service, forest-classification.service).
                    const p = f.properties || {};
                    const props = {
                        ADM2_CODE: p.CODE_2002 || p.ADM2_CODE || p.OBJECTID || null,
                        ADM2_NAME: p.NAME_VN   || p.ADM2_NAME || p.NAME_EN || null,
                        NAME_EN:   p.NAME_EN   || p.ADM2_NAME || null,
                        NAME_VN:   p.NAME_VN   || null,
                        source:    'LOCAL_RANHGIOIHUYEN_WGS84',
                    };
                    return ee.Feature(ee.Geometry(geom), props);
                });
                _cachedDistrictsFC     = ee.FeatureCollection(eeFeats);
                _cachedDistrictsSource = 'LOCAL_RANHGIOIHUYEN_WGS84';
                return _cachedDistrictsFC;
            }
            console.warn(`[GEE-SAT] ${KON_TUM_DISTRICTS_PATH} không có features hợp lệ, fallback FAO/GAUL.`);
        } catch (err) {
            console.warn(`[GEE-SAT] Lỗi đọc ${KON_TUM_DISTRICTS_PATH}: ${err.message}, fallback FAO/GAUL.`);
        }
    }

    _cachedDistrictsFC = ee.FeatureCollection('FAO/GAUL/2015/level2')
        .filter(ee.Filter.eq('ADM0_NAME', 'Viet Nam'))
        .filter(ee.Filter.eq('ADM1_NAME', 'Kon Tum'));
    _cachedDistrictsSource = 'FAO_GAUL_2015_LEVEL2';
    return _cachedDistrictsFC;
}

/**
 * Nguồn thực tế của getKonTumDistricts đã cache — dùng để log / debug.
 * Trả về `null` nếu getKonTumDistricts() chưa được gọi.
 */
function getKonTumDistrictsSource() {
    return _cachedDistrictsSource;
}

// ── Local Kon Tum boundary polygon ────────────────────────────────────────────

// Recursively strip Z/M components so ee.Geometry accepts the coords —
// the source file stores [x, y, 0] triplets which GEE rejects.
function _stripZ(coords) {
    if (typeof coords[0] === 'number') return coords.slice(0, 2);
    return coords.map(_stripZ);
}

// Extract the numeric EPSG code from either "EPSG:XXXX" or a CRS URN
// like "urn:ogc:def:crs:EPSG::XXXX".
function _parseEpsgCode(crsName) {
    const m = String(crsName || '').match(/EPSG:*:*(\d+)$/i);
    return m ? m[1] : null;
}

let _cachedBoundaryGeom = null;

/**
 * Load the Kon Tum province polygon from the configured GeoJSON file.
 * Lazily evaluated and cached. Throws if the file is missing or invalid.
 */
function getKonTumBoundaryGeometry() {
    if (_cachedBoundaryGeom) return _cachedBoundaryGeom;
    const raw = fs.readFileSync(KON_TUM_BOUNDARY_PATH, 'utf8');
    const doc = JSON.parse(raw);
    const feature = doc.type === 'FeatureCollection'
        ? doc.features?.[0]
        : (doc.type === 'Feature' ? doc : null);
    const geom = feature?.geometry || (doc.type === 'Polygon' || doc.type === 'MultiPolygon' ? doc : null);
    if (!geom) throw new Error(`[GEE-SAT] Không tìm thấy polygon geometry trong file: ${KON_TUM_BOUNDARY_PATH}`);

    const crsName   = doc.crs?.properties?.name;
    const epsg      = _parseEpsgCode(crsName);
    const projLabel = epsg ? `EPSG:${epsg}` : 'EPSG:4326';

    const cleanGeom = {
        type: geom.type,
        coordinates: _stripZ(geom.coordinates),
    };

    // Non-WGS84 → geodesic=false (planar/UTM). WGS84 → geodesic=true default.
    _cachedBoundaryGeom = epsg && epsg !== '4326'
        ? ee.Geometry(cleanGeom, projLabel, false)
        : ee.Geometry(cleanGeom);
    return _cachedBoundaryGeom;
}

/**
 * Parse a geometry parameter (GeoJSON object or bbox array [minX,minY,maxX,maxY])
 * into an ee.Geometry. Falls back to RanhGioiTinh_Polygon.geojson when omitted.
 */
function toEeGeometry(geometry) {
    if (!geometry) {
        return getKonTumBoundaryGeometry();
    }
    if (Array.isArray(geometry) && geometry.length === 4) {
        const [minX, minY, maxX, maxY] = geometry;
        return ee.Geometry.BBox(minX, minY, maxX, maxY);
    }
    return ee.Geometry(geometry);
}

// ── Image masking & preparation ───────────────────────────────────────────────

/**
 * Landsat Collection 2 Level-2 cloud mask using QA_PIXEL.
 * Removes fill, dilated cloud, cloud, cloud shadow, snow.
 */
function maskLandsatC2(image) {
    const qa   = image.select('QA_PIXEL');
    const mask = qa.bitwiseAnd(1 << 0).eq(0)   // fill
        .and(qa.bitwiseAnd(1 << 1).eq(0))       // dilated cloud
        .and(qa.bitwiseAnd(1 << 3).eq(0))       // cloud
        .and(qa.bitwiseAnd(1 << 4).eq(0))       // cloud shadow
        .and(qa.bitwiseAnd(1 << 5).eq(0));      // snow
    return image.updateMask(mask);
}

/** Prepare Landsat 5/7 C2 L2 optical bands → blue/green/red/nir/swir1/swir2 */
function prepL57(image) {
    return image
        .select(['SR_B1', 'SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B7'],
                ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'])
        .multiply(0.0000275).add(-0.2).clamp(0, 1).toFloat()
        .copyProperties(image, ['system:time_start']);
}

/** Prepare Landsat 8/9 C2 L2 optical bands → blue/green/red/nir/swir1/swir2 */
function prepL89(image) {
    return image
        .select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'],
                ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'])
        .multiply(0.0000275).add(-0.2).clamp(0, 1).toFloat()
        .copyProperties(image, ['system:time_start']);
}

/**
 * Sentinel-2 SR cloud mask using SCL band.
 * Renames bands → blue/green/red/nir/swir1/swir2 (same schema as Landsat prep).
 */
function maskS2(image) {
    const scl  = image.select('SCL');
    const mask = scl.neq(3).and(scl.neq(8)).and(scl.neq(9))
        .and(scl.neq(10)).and(scl.neq(11));
    return image
        .select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'],
                ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'])
        .multiply(0.0001).clamp(0, 1).toFloat()
        .updateMask(mask)
        .copyProperties(image, ['system:time_start']);
}

/**
 * Mask S2 using only SCL (no rename — keeps original band names B2/B3…).
 * Used by fire-risk service which needs B8/B11/B12 names.
 */
function maskS2FireRisk(image) {
    const scl = image.select('SCL');
    const cloudMask = scl.neq(3).and(scl.neq(8)).and(scl.neq(9))
        .and(scl.neq(10)).and(scl.neq(11)).and(scl.neq(0)).and(scl.neq(1));
    return image.select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'])
        .multiply(0.0001)
        .updateMask(cloudMask)
        .copyProperties(image, ['system:time_start']);
}

// ── Composite ─────────────────────────────────────────────────────────────────

/**
 * Build a cloud-free median composite for a given year/month range.
 * Merges Landsat 5/7/8/9 + Sentinel-2 (if year >= 2017).
 * Returns a 6-band image: blue/green/red/nir/swir1/swir2.
 */
function makeComposite(year, startMonth, endMonth, region) {
    const startDate = ee.Date.fromYMD(year, startMonth, 1);
    const endDate   = ee.Date.fromYMD(year, endMonth, 1).advance(1, 'month');
    const bounds    = region || getKonTumBoundaryGeometry();

    const l5 = ee.ImageCollection('LANDSAT/LT05/C02/T1_L2')
        .filterBounds(bounds).filterDate(startDate, endDate)
        .map(maskLandsatC2).map(prepL57);
    const l7 = ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
        .filterBounds(bounds).filterDate(startDate, endDate)
        .map(maskLandsatC2).map(prepL57);
    const l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
        .filterBounds(bounds).filterDate(startDate, endDate)
        .map(maskLandsatC2).map(prepL89);
    const l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
        .filterBounds(bounds).filterDate(startDate, endDate)
        .map(maskLandsatC2).map(prepL89);

    let collection = l5.merge(l7).merge(l8).merge(l9);

    if (year >= 2017) {
        const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
            .filterBounds(bounds)
            .filterDate(startDate, endDate)
            .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 60))
            .map(maskS2);
        collection = collection.merge(s2);
    }

    const bands  = ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'];
    const mapped = collection.map((img) =>
        img.select(bands).clamp(0, 1).toFloat()
            .copyProperties(img, ['system:time_start']));

    // Fallback: masked constant image with correct band schema.
    // Prevents "Band pattern 'blue' was applied to an Image with no bands" when
    // the merged collection is empty (e.g. seasonal window in the future).
    const fallback = ee.Image.constant([0.12, 0.10, 0.08, 0.40, 0.20, 0.12])
        .rename(bands)
        .updateMask(ee.Image.constant(0));

    const composite = ee.Image(ee.Algorithms.If(
        mapped.size().gt(0),
        mapped.median(),
        fallback,
    ));

    return composite.select(bands).clip(bounds).toFloat();
}

// ── Spectral indices ──────────────────────────────────────────────────────────

/**
 * Compute 8 spectral indices from a 6-band image (blue/green/red/nir/swir1/swir2).
 * All output bands are prefixed with `prefix_` (e.g. 'base_NDVI').
 * If prefix is empty string, no prefix is added.
 */
function addIndices(image, prefix) {
    const p = prefix ? prefix + '_' : '';
    const ndvi  = image.normalizedDifference(['nir',   'red'])  .rename(p + 'NDVI');
    const ndwi  = image.normalizedDifference(['green', 'nir'])  .rename(p + 'NDWI');
    const mndwi = image.normalizedDifference(['green', 'swir1']).rename(p + 'MNDWI');
    const ndmi  = image.normalizedDifference(['nir',   'swir1']).rename(p + 'NDMI');
    const ndbi  = image.normalizedDifference(['swir1', 'nir'])  .rename(p + 'NDBI');
    const nbr   = image.normalizedDifference(['nir',   'swir2']).rename(p + 'NBR');
    const bsi   = image.expression(
        '((SWIR + RED) - (NIR + BLUE)) / ((SWIR + RED) + (NIR + BLUE))',
        { SWIR: image.select('swir1'), RED: image.select('red'),
          NIR: image.select('nir'),   BLUE: image.select('blue') },
    ).rename(p + 'BSI');
    const evi   = image.expression(
        '2.5 * ((NIR - RED) / (NIR + 6 * RED - 7.5 * BLUE + 1))',
        { NIR: image.select('nir'), RED: image.select('red'), BLUE: image.select('blue') },
    ).rename(p + 'EVI');
    return ee.Image.cat([ndvi, ndwi, mndwi, ndmi, ndbi, nbr, bsi, evi]);
}

// ── Collection helpers ────────────────────────────────────────────────────────

/**
 * Return median image, or a masked constant fallback if collection is empty.
 * Used with fire-risk S2 collections that keep original band names.
 */
function medianOrFallback(collection, bands, fallbackValues) {
    const fallback = ee.Image.constant(fallbackValues)
        .rename(bands)
        .updateMask(ee.Image.constant(0));
    return ee.Image(
        ee.Algorithms.If(
            collection.size().gt(0),
            collection.select(bands).median(),
            fallback,
        ),
    );
}

// ── DEM helpers ───────────────────────────────────────────────────────────────

/** Return elevation/slope/aspect from SRTM for the given region. */
function getDemBands(region) {
    const dem       = ee.Image('USGS/SRTMGL1_003').clip(region || getKonTumBoundaryGeometry());
    const elevation = dem.rename('elevation');
    const slope     = ee.Terrain.slope(dem).rename('slope');
    const aspect    = ee.Terrain.aspect(dem).rename('aspect');
    return { elevation, slope, aspect };
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Generate a temporary GEE download URL for a satellite image (GeoTIFF).
 * Returns null if the image is too large or GEE rejects the request.
 */
async function getEeDownloadUrl(eeImage, region, vizParams = {}) {
    try {
        const visImage = Object.keys(vizParams).length > 0
            ? eeImage.visualize(vizParams)
            : eeImage;
        return await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 20_000);
            visImage.getDownloadURL({
                name: 'satellite',
                scale: 100,
                region,
                fileFormat: 'GeoTIFF',
                maxPixels: 1e8,
            }, (url, err) => {
                clearTimeout(timer);
                resolve(err ? null : url);
            });
        });
    } catch (e) {
        return null;
    }
}

/** Current date as 'YYYY-MM-DD' string (UTC). */
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Format Date or string as 'YYYY-MM-DD'. */
const fmtDate = (d) => {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toISOString().slice(0, 10);
};

module.exports = {
    eeEval,
    getEeMapId,
    getEeDownloadUrl,
    getKonTumRegion,
    getKonTumDistricts,
    getKonTumDistrictsSource,
    getKonTumBoundaryGeometry,
    toEeGeometry,
    maskLandsatC2,
    prepL57,
    prepL89,
    maskS2,
    maskS2FireRisk,
    makeComposite,
    addIndices,
    medianOrFallback,
    getDemBands,
    todayUtc,
    fmtDate,
};
