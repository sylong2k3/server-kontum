'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../configs/database');
const { geoserverConfig } = require('../configs/geoserver');
const { Api400Error, Api403Error, Api404Error, Api409Error } = require('../core/error.response');
const repo = require('../repositories/layer-series.repository');
const geoserver = require('../utils/geoserver.client');
const { t } = require('../utils/i18n.util');

const ADMIN_ROLES = new Set(['system_admin', 'so_nnmt']);
const isAdmin = (user) => Boolean(user && ADMIN_ROLES.has(user.role));
const safeUnlink = async (filePath) => {
    if (!filePath) { return; }
    await fs.promises.unlink(filePath).catch(() => {});
};

const requireGroup = async (code, user, lang) => {
    const group = await repo.findGroupByCode(code);
    if (!group || group.is_active !== true) {
        throw new Api404Error(t('layer_series_group_not_found', lang), ['GROUP_NOT_FOUND']);
    }
    if (group.is_public !== true && !isAdmin(user)) {
        throw new Api403Error(t('map_layer_read_forbidden', lang), ['MAP_LAYER_READ_FORBIDDEN']);
    }
    return group;
};

const publicGeoserverRoot = () => {
    const configured = process.env.GEOSERVER_PUBLIC_URL || geoserverConfig.url || '';
    return configured.trim().replace(/\/+$/, '').replace(/\/(?:wms|wcs)$/i, '');
};

const buildTileUrl = (group, timeValue) => {
    const root = publicGeoserverRoot();
    if (!root) { return null; }
    const workspace = String(group.geoserver_layer).includes(':')
        ? String(group.geoserver_layer).split(':')[0]
        : geoserverConfig.workspace;
    const base = root.endsWith(`/${workspace}`) ? root : `${root}/${workspace}`;
    const params = new URLSearchParams({
        service: 'WMS',
        version: '1.1.1',
        request: 'GetMap',
        layers: group.geoserver_layer,
        styles: group.geoserver_style || '',
        format: 'image/png',
        transparent: 'true',
        srs: 'EPSG:3857',
        width: '256',
        height: '256',
        time: timeValue,
    });
    return `${base}/wms?${params.toString()}&bbox={bbox-epsg-3857}`;
};

const toStep = (group, row) => {
    const time = row.time_value instanceof Date
        ? row.time_value.toISOString().slice(0, 10)
        : String(row.time_value).slice(0, 10);
    return {
        id: row.id,
        year_from: row.year_from,
        year_to: row.year_to,
        label: row.label,
        time,
        tile_url: buildTileUrl(group, time),
    };
};

const listGroups = async (user) => {
    const groups = await repo.listGroups({ includePrivate: isAdmin(user) });
    return groups.map((group) => ({
        code: group.code,
        name_vi: group.name_vi,
        name_en: group.name_en,
        step_count: group.step_count,
        min_year: group.min_year,
        max_year: group.max_year,
        geoserver_layer: group.geoserver_layer,
        default_style: group.geoserver_style,
    }));
};

const getTimeline = async (code, user, lang) => {
    const group = await requireGroup(code, user, lang);
    const granules = await repo.listGranules(group.id);
    const steps = granules.map((row) => toStep(group, row));
    return {
        group: {
            code: group.code,
            name_vi: group.name_vi,
            name_en: group.name_en,
            geoserver_layer: group.geoserver_layer,
            default_style: group.geoserver_style,
        },
        mode: 'discrete',
        snap: 'nearest',
        default_index: steps.length ? steps.length - 1 : null,
        min_year: steps.length ? Math.min(...steps.map((step) => step.year_from)) : null,
        max_year: steps.length ? Math.max(...steps.map((step) => step.year_to)) : null,
        steps,
    };
};

// Use a deterministic day inside year_to. It preserves chronological order and
// keeps intervals sharing year_to unique without pretending raster interpolation.
const buildTimeValue = (yearFrom, yearTo) => {
    const dayOfYear = yearFrom - 1900 + 1;
    const date = new Date(Date.UTC(yearTo, 0, dayOfYear));
    return date.toISOString().slice(0, 10);
};

const writeMosaicConfig = async (dir) => {
    await fs.promises.writeFile(path.join(dir, 'indexer.properties'), [
        'TimeAttribute=ingestion',
        'Schema=*the_geom:Polygon,location:String,ingestion:java.util.Date',
        'PropertyCollectors=TimestampFileNameExtractorSPI[timeregex](ingestion)',
        '',
    ].join('\n'), { flag: 'wx' }).catch((error) => {
        if (error.code !== 'EEXIST') { throw error; }
    });
    await fs.promises.writeFile(
        path.join(dir, 'timeregex.properties'),
        'regex=[0-9]{4}-[0-9]{2}-[0-9]{2}\n',
        { flag: 'wx' }
    ).catch((error) => {
        if (error.code !== 'EEXIST') { throw error; }
    });
};

const ingestGranule = async ({ groupCode, file, payload, user, lang = 'vi' }) => {
    if (!file?.path) {
        throw new Api400Error(t('layer_series_file_required', lang), ['FILE_REQUIRED']);
    }

    let publishedPath = null;
    let geoserverAccepted = false;
    try {
        const group = await requireGroup(groupCode, user, lang);
        const existing = await repo.findGranule(group.id, payload.year_from, payload.year_to);
        if (existing && !payload.force) {
            throw new Api409Error(t('layer_series_granule_exists', lang), ['GRANULE_EXISTS']);
        }
        const currentGranules = await repo.listGranules(group.id);

        const dataDir = String(process.env.GEOSERVER_DATA_DIR || '').trim();
        if (!dataDir) {
            throw new Api400Error(t('map_geo_raster_dir_missing', lang), ['GEOSERVER_DATA_DIR_REQUIRED']);
        }

        const timeValue = buildTimeValue(payload.year_from, payload.year_to);
        const mosaicDir = path.resolve(dataDir, 'layer-series', group.code);
        const resolvedBase = path.resolve(dataDir, 'layer-series');
        if (!mosaicDir.startsWith(`${resolvedBase}${path.sep}`)) {
            throw new Api400Error(t('invalid_data', lang), ['INVALID_MOSAIC_PATH']);
        }
        await fs.promises.mkdir(mosaicDir, { recursive: true });
        await writeMosaicConfig(mosaicDir);

        const fileName = `${group.code}_${timeValue}.tif`;
        publishedPath = path.join(mosaicDir, fileName);
        if (!payload.force && fs.existsSync(publishedPath)) {
            throw new Api409Error(t('layer_series_granule_exists', lang), ['GRANULE_FILE_EXISTS']);
        }
        await fs.promises.copyFile(file.path, publishedPath);

        if (existing) {
            // File is already indexed at this TIME. Replacing it plus truncating GWC is enough.
            geoserverAccepted = true;
        } else if (currentGranules.length > 0) {
            await geoserver.harvestGeoTiff(group.geoserver_store, publishedPath);
            geoserverAccepted = true;
        } else {
            await geoserver.publishTimeMosaic({
                storeName: group.geoserver_store,
                mosaicPath: mosaicDir,
                title: group.name_vi,
            });
            geoserverAccepted = true;
        }
        await geoserver.truncateGwcLayer(group.geoserver_layer).catch((error) => {
            console.warn(`[LAYER-SERIES] GWC truncate failed: ${error.message}`);
        });

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const row = await repo.upsertGranule(client, {
                groupId: group.id,
                yearFrom: payload.year_from,
                yearTo: payload.year_to,
                timeValue,
                label: payload.label || (payload.year_from === payload.year_to
                    ? String(payload.year_from)
                    : `${payload.year_from}–${payload.year_to}`),
                fileName,
                sourceLayer: payload.source_layer,
                sourceUrl: payload.source_url,
                createdBy: user?.id,
            });
            await client.query('COMMIT');
            return toStep(group, row);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        if (publishedPath && !geoserverAccepted) { await safeUnlink(publishedPath); }
        throw error;
    } finally {
        await safeUnlink(file?.path);
    }
};

module.exports = {
    buildTileUrl,
    buildTimeValue,
    getTimeline,
    ingestGranule,
    listGroups,
};
