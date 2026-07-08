'use strict';

/**
 * Shared GEE (Google Earth Engine) satellite utilities.
 *
 * Used by: satellite.service.js, forest-classification.service.js, fire-risk.service.js
 *
 * All functions accept/return EE objects unless noted with "→ JS value".
 */

const { ee } = require('../configs/gge');

// Default timeout for .evaluate() calls (5 minutes).
const DEFAULT_TIMEOUT_MS = parseInt(process.env.GEE_TIMEOUT_MS, 10) || 5 * 60 * 1000;

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
 * → JS value
 */
function getEeMapId(eeImage, vizParams = {}) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('GEE getMapId timeout')),
            DEFAULT_TIMEOUT_MS,
        );
        ee.data.getMapId(
            { image: eeImage, ...vizParams },
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

const GAUL_ADM0  = 'Viet Nam';
const GAUL_ADM1  = 'Kon Tum';

function getKonTumRegion() {
    return ee.FeatureCollection('FAO/GAUL/2015/level1')
        .filter(ee.Filter.eq('ADM0_NAME', GAUL_ADM0))
        .filter(ee.Filter.eq('ADM1_NAME', GAUL_ADM1));
}

function getKonTumDistricts() {
    return ee.FeatureCollection('FAO/GAUL/2015/level2')
        .filter(ee.Filter.eq('ADM0_NAME', GAUL_ADM0))
        .filter(ee.Filter.eq('ADM1_NAME', GAUL_ADM1));
}

/**
 * Parse a geometry parameter (GeoJSON object or bbox array [minX,minY,maxX,maxY])
 * into an ee.Geometry. Falls back to Kon Tum province if null.
 */
function toEeGeometry(geometry) {
    if (!geometry) return getKonTumRegion().geometry();
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
    const bounds    = region || getKonTumRegion();

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

    const bands = ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'];
    return collection
        .map((img) => img.select(bands).clamp(0, 1).toFloat()
            .copyProperties(img, ['system:time_start']))
        .median()
        .select(bands)
        .clip(bounds)
        .toFloat();
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
    const dem       = ee.Image('USGS/SRTMGL1_003').clip(region || getKonTumRegion());
    const elevation = dem.rename('elevation');
    const slope     = ee.Terrain.slope(dem).rename('slope');
    const aspect    = ee.Terrain.aspect(dem).rename('aspect');
    return { elevation, slope, aspect };
}

// ── Date helpers ──────────────────────────────────────────────────────────────

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
    getKonTumRegion,
    getKonTumDistricts,
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
    GAUL_ADM0,
    GAUL_ADM1,
};
