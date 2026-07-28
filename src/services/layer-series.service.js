'use strict';

const { geoserverConfig } = require('../configs/geoserver');
const { Api404Error } = require('../core/error.response');
const repo = require('../repositories/layer-series.repository');
const { t } = require('../utils/i18n.util');

const ADMIN_ROLES = new Set(['system_admin', 'so_nnmt']);
const isAdmin = (user) => Boolean(user && ADMIN_ROLES.has(user.role));

const GROUPS = {
    lop_phu: { name_vi: 'Lớp phủ', name_en: 'Land cover', sourceGroups: ['lop_phu'] },
    nhiet_do_be_mat: { name_vi: 'Nhiệt độ bề mặt', name_en: 'Land surface temperature', sourceGroups: ['nhiet_do_be_mat'] },
    bien_dong_lop_phu: { name_vi: 'Biến động lớp phủ', name_en: 'Land-cover change', sourceGroups: ['bien_dong_lop_phu'] },
    dien_bien_nhiet_do: {
        name_vi: 'Diễn biến nhiệt độ', name_en: 'Temperature change',
        sourceGroups: ['dien_bien_nhiet_do', 'bien_dong_nhiet_do'],
    },
};

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
        tile_url: buildTileUrl(layer),
    };
};

const layersFor = (group, user) => repo.listSourceLayers({
    sourceGroups: group.sourceGroups,
    includePrivate: isAdmin(user),
});

const listGroups = async (user) => Promise.all(Object.entries(GROUPS).map(async ([code, group]) => {
    const steps = (await layersFor(group, user)).map(toStep).filter((step) => step.year_from && step.year_to);
    return {
        code, name_vi: group.name_vi, name_en: group.name_en,
        step_count: steps.length,
        min_year: steps.length ? Math.min(...steps.map((step) => step.year_from)) : null,
        max_year: steps.length ? Math.max(...steps.map((step) => step.year_to)) : null,
    };
}));

const getTimeline = async (code, user, lang) => {
    const group = GROUPS[code];
    if (!group) {
        throw new Api404Error(t('layer_series_group_not_found', lang), ['GROUP_NOT_FOUND']);
    }
    const steps = (await layersFor(group, user)).map(toStep).filter((step) => step.year_from && step.year_to);
    steps.sort((a, b) => a.year_to - b.year_to || a.year_from - b.year_from || a.layer_code.localeCompare(b.layer_code));
    return {
        group: { code, name_vi: group.name_vi, name_en: group.name_en },
        mode: 'discrete', snap: 'nearest',
        default_index: steps.length ? steps.length - 1 : null,
        min_year: steps.length ? Math.min(...steps.map((step) => step.year_from)) : null,
        max_year: steps.length ? Math.max(...steps.map((step) => step.year_to)) : null,
        steps,
    };
};

module.exports = { buildTileUrl, getTimeline, listGroups, periodOf };
