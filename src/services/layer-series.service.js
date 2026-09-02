'use strict';

const { geoserverConfig } = require('../configs/geoserver');
const { Api404Error, Api409Error } = require('../core/error.response');
const repo = require('../repositories/layer-series.repository');
const { t } = require('../utils/i18n.util');

const ADMIN_ROLES = new Set(['system_admin', 'so_nnmt']);
const isAdmin = (user) => Boolean(user && ADMIN_ROLES.has(user.role));

const publicGeoserverRoot = () => {
    const configured = process.env.GEOSERVER_PUBLIC_URL || geoserverConfig.url || '';
    return configured.trim().replace(/\/+$/, '').replace(/\/(?:wms|wcs)$/i, '');
};

const styleName = (value) => typeof value === 'string' ? value : (value?.name || value?.style || '');

const buildTileUrl = (layer) => {
    const root = publicGeoserverRoot();
    if (!root || !layer.geoserver_layer) { return null; }
    const workspace = String(layer.geoserver_layer).includes(':')
        ? String(layer.geoserver_layer).split(':')[0]
        : geoserverConfig.workspace;
    const base = root.endsWith(`/${workspace}`) ? root : `${root}/${workspace}`;
    const params = new URLSearchParams({
        service: 'WMS', version: '1.1.1', request: 'GetMap',
        layers: layer.geoserver_layer, styles: styleName(layer.default_style),
        format: 'image/png', transparent: 'true', srs: 'EPSG:3857',
        width: '256', height: '256',
    });
    return `${base}/wms?${params.toString()}&bbox={bbox-epsg-3857}`;
};

const periodOf = (layer) => {
    const years = String(layer.code || layer.geoserver_layer || '').match(/(?:19|20)\d{2}/g)?.map(Number) || [];
    const fallback = Number(layer.data_year) || null;
    if (years.length >= 2) {
        return { yearFrom: years[years.length - 2], yearTo: years[years.length - 1] };
    }
    const year = years[0] || fallback;
    return { yearFrom: year, yearTo: year };
};

const toStep = (layer) => {
    const { yearFrom, yearTo } = periodOf(layer);
    return {
        id: layer.id,
        layer_code: layer.code,
        geoserver_layer: layer.geoserver_layer,
        year_from: yearFrom,
        year_to: yearTo,
        label: yearFrom === yearTo ? String(yearFrom) : `${yearFrom}–${yearTo}`,
        sort_order: layer.sort_order ?? 0,
        tile_url: buildTileUrl(layer),
    };
};

const aggregateLegend = (layers = []) => {
    const seen = new Set();
    const uniqueEntries = [];

    for (const layer of layers) {
        if (!layer || !layer.legend_config) continue;
        let config = layer.legend_config;
        if (typeof config === 'string') {
            try {
                config = JSON.parse(config);
            } catch {
                continue;
            }
        }
        if (!config) continue;
        const entries = Array.isArray(config)
            ? config
            : (Array.isArray(config.entries) ? config.entries : (Array.isArray(config.items) ? config.items : []));

        for (const entry of entries) {
            if (!entry) continue;
            const label = String(entry.label || entry.name || entry.title || '').trim();
            const color = String(entry.color || entry.fill || '').trim();
            if (!label && !color) continue;

            const key = `${label.toLowerCase()}|||${color.toLowerCase()}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueEntries.push({
                    label: label || color,
                    color: color || '#000000',
                    ...(entry.value !== undefined ? { value: entry.value } : {}),
                    ...(entry.opacity !== undefined ? { opacity: entry.opacity } : {}),
                });
            }
        }
    }

    if (!uniqueEntries.length) return null;
    return {
        type: 'custom',
        entries: uniqueEntries,
    };
};

const sourceGroupsFor = (code) => code === 'dien_bien_nhiet_do'
    ? ['dien_bien_nhiet_do', 'bien_dong_nhiet_do']
    : [code];

const layersFor = (group, user) => repo.listSourceLayers({
    sourceGroups: sourceGroupsFor(group.code),
    includePrivate: isAdmin(user),
});

const listGroups = async (user) => {
    const groups = await repo.listGroups({ includePrivate: isAdmin(user) });
    return Promise.all(groups.map(async (group) => {
        const rawLayers = await layersFor(group, user);
        const steps = rawLayers.map(toStep).filter((step) => step.year_from && step.year_to);
        const legend = aggregateLegend(rawLayers);
        return {
            ...group,
            legend,
            step_count: steps.length,
            min_year: steps.length ? Math.min(...steps.map((step) => step.year_from)) : null,
            max_year: steps.length ? Math.max(...steps.map((step) => step.year_to)) : null,
        };
    }));
};

const getTimeline = async (code, user, lang) => {
    const group = await repo.findGroupByCode(code);
    if (!group || (!isAdmin(user) && (!group.is_active || !group.is_public))) {
        throw new Api404Error(t('layer_series_group_not_found', lang), ['GROUP_NOT_FOUND']);
    }
    const rawLayers = await layersFor(group, user);
    const steps = rawLayers.map(toStep).filter((step) => step.year_from && step.year_to);
    const legend = aggregateLegend(rawLayers);

    // Ưu tiên sort_order (thứ tự admin đã kéo thả). Fallback về năm khi
    // sort_order bằng nhau (thường là 0 — chưa reorder).
    steps.sort((a, b) =>
        (a.sort_order - b.sort_order)
        || (a.year_to - b.year_to)
        || (a.year_from - b.year_from)
        || a.layer_code.localeCompare(b.layer_code)
    );
    return {
        group: {
            code, name_vi: group.name_vi, name_en: group.name_en,
            geoserver_layer: group.geoserver_layer,
            default_style: group.geoserver_style,
            legend,
        },
        legend,
        mode: 'discrete', snap: 'nearest',
        default_index: steps.length ? steps.length - 1 : null,
        min_year: steps.length ? Math.min(...steps.map((step) => step.year_from)) : null,
        max_year: steps.length ? Math.max(...steps.map((step) => step.year_to)) : null,
        steps,
    };
};

/**
 * Suy ra 2 field kỹ thuật geoserver_store + geoserver_layer từ layer con của
 * nhóm (nếu có), hoặc fallback về default GeoServer store + template
 * `${workspace}:${code}`. Admin/UI không cần bận tâm.
 */
const resolveGeoserverRefs = async (payload) => {
    const filled = { ...payload };
    const hasStore = Boolean(filled.geoserver_store);
    const hasLayer = Boolean(filled.geoserver_layer);
    if (hasStore && hasLayer) return filled;

    const firstChild = await repo.findFirstSourceLayer(filled.code);
    if (!hasStore) {
        filled.geoserver_store = firstChild?.geoserver_store
            || geoserverConfig.datastore
            || 'kontum_raster_store';
    }
    if (!hasLayer) {
        const workspace = geoserverConfig.workspace || 'kontum';
        filled.geoserver_layer = firstChild?.geoserver_layer
            || `${workspace}:${filled.code}`;
    }
    return filled;
};

const createGroup = async (payload, lang) => {
    if (await repo.findGroupByCode(payload.code)) {
        throw new Api409Error(
            lang === 'en' ? 'Layer group code already exists' : 'Mã nhóm lớp đã tồn tại',
            ['LAYER_GROUP_CODE_EXISTS']
        );
    }
    const resolved = await resolveGeoserverRefs(payload);
    return repo.createGroup(resolved);
};

const updateGroup = async (code, payload, lang) => {
    if (!await repo.findGroupByCode(code)) {
        throw new Api404Error(t('layer_series_group_not_found', lang), ['GROUP_NOT_FOUND']);
    }
    return repo.updateGroup(code, payload);
};

const deleteGroup = async (code, lang) => {
    const deleted = await repo.deleteGroup(code);
    if (!deleted) {
        throw new Api404Error(t('layer_series_group_not_found', lang), ['GROUP_NOT_FOUND']);
    }
    return deleted;
};

const reorderSteps = async (code, order, lang) => {
    if (!await repo.findGroupByCode(code)) {
        throw new Api404Error(t('layer_series_group_not_found', lang), ['GROUP_NOT_FOUND']);
    }
    const updated = await repo.reorderSourceLayers({ groupCode: code, order });
    return { updated_count: updated, order };
};

module.exports = {
    buildTileUrl,
    createGroup,
    deleteGroup,
    getTimeline,
    listGroups,
    periodOf,
    reorderSteps,
    updateGroup,
};
