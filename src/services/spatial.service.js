'use strict';

/**
 * Spatial Analysis Service (EP-07).
 *
 * US-061: Thay đổi rừng giữa 2 mốc thời gian (tabular từ landcover_statistics).
 *         Phân tích suy giảm mức raster/NDVI cần GEE — phụ thuộc EP-04/EP-06.
 * US-062: Khoảng cách dân cư – rừng (ST_DWithin trên lớp GIS đã import).
 */

const repo  = require('../repositories/spatial.repository');
const statsRepo = require('../repositories/statistics.repository');
const { Api400Error, Api404Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const round = (n, d = 2) => (n == null ? null : Number(Number(n).toFixed(d)));

// ══════════════════════════════════════════════════════════════════════════════
//  US-061 — Thay đổi rừng giữa 2 mốc
// ══════════════════════════════════════════════════════════════════════════════
const getForestChange = async ({ fromYear, toYear, forestType = 'total', unitCode = null, lang }) => {
    if (fromYear === toYear) {
        throw new Api400Error(t('spatial_same_year', lang), ['SAME_YEAR']);
    }

    const years = await statsRepo.getAvailableYears();
    const missing = [fromYear, toYear].filter((y) => !years.includes(y));
    if (missing.length) {
        throw new Api400Error(
            t('spatial_year_not_available', lang, { years: years.join(', ') }),
            ['YEAR_NOT_AVAILABLE'],
        );
    }

    const rows = await repo.getForestChange({ fromYear, toYear, forestType, unitCode });
    if (rows.length === 0) {
        return { fromYear, toYear, forestType, items: [], summary: null, no_data: true };
    }

    const items = rows.map((r) => ({
        unitCode:       r.unit_code,
        name:           r.name_vi,
        fromAreaHa:     round(r.from_area_ha),
        toAreaHa:       round(r.to_area_ha),
        deltaAreaHa:    round(r.delta_area_ha),
        deltaPct:       round(r.delta_pct),
        fromCoveragePct: round(r.from_coverage_pct),
        toCoveragePct:  round(r.to_coverage_pct),
        trend:          r.delta_area_ha > 0 ? 'increase' : (r.delta_area_ha < 0 ? 'decrease' : 'stable'),
    }));

    const totalDelta = items.reduce((s, i) => s + (i.deltaAreaHa || 0), 0);

    return {
        fromYear, toYear, forestType,
        items,
        summary: {
            unitCount:        items.length,
            totalDeltaHa:     round(totalDelta),
            increasedCount:   items.filter((i) => i.trend === 'increase').length,
            decreasedCount:   items.filter((i) => i.trend === 'decrease').length,
        },
        // Phân tích suy giảm mức pixel (vùng ΔNDVI < ngưỡng) cần GEE/raster.
        rasterAnalysis: { available: false, note: 'Phân tích NDVI/raster cần tích hợp GEE (EP-04/EP-06)' },
        no_data: false,
    };
};

// ══════════════════════════════════════════════════════════════════════════════
//  US-062 — Khoảng cách dân cư – rừng
// ══════════════════════════════════════════════════════════════════════════════
const getResidentialDistance = async ({ residentialCode, forestCode, thresholdM, limit, lang }) => {
    const residentialLayer = await repo.findLayerByCode(residentialCode);
    if (!residentialLayer) {
        throw new Api404Error(t('spatial_layer_not_found', lang, { code: residentialCode }), ['LAYER_NOT_FOUND']);
    }
    const forestLayer = await repo.findLayerByCode(forestCode);
    if (!forestLayer) {
        throw new Api404Error(t('spatial_layer_not_found', lang, { code: forestCode }), ['LAYER_NOT_FOUND']);
    }

    const rows = await repo.findResidentialNearForest({
        residentialLayer, forestLayer, thresholdM, limit,
    });

    const features = rows.map((r) => ({
        type: 'Feature',
        geometry: r.geojson,
        properties: { featureId: r.feature_id, distanceM: round(r.distance_m) },
    }));

    return {
        type: 'FeatureCollection',
        thresholdM,
        residentialLayer: { code: residentialLayer.code, name: residentialLayer.name_vi },
        forestLayer:      { code: forestLayer.code, name: forestLayer.name_vi },
        features,
        metadata: { returned: features.length, limit, thresholdM },
    };
};

module.exports = {
    getForestChange,
    getResidentialDistance,
};
