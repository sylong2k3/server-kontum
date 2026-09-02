'use strict';

/**
 * Spatial Analysis Service (EP-07).
 *
 * US-062: Khoảng cách dân cư – rừng (ST_DWithin trên lớp GIS đã import).
 */

const repo  = require('../repositories/spatial.repository');
const { Api404Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const round = (n, d = 2) => (n == null ? null : Number(Number(n).toFixed(d)));

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
    getResidentialDistance,
};
