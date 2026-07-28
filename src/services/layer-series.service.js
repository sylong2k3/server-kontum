'use strict';

/**
 * Layer Series Service — time-series cho các nhóm raster nhiều năm
 * (lop_phu, nhiet_do_be_mat, bien_dong_lop_phu, dien_bien_nhiet_do).
 *
 * Mỗi nhóm publish thành DUY NHẤT 1 GeoServer layer kiểu ImageMosaic có time
 * dimension (xem geoserver.client.js#publishTimelapseLayer/enableTimeDimension),
 * client chọn năm/giai đoạn bằng WMS `&TIME=<time_value>` thay vì đổi layer.
 *
 * time_value là mốc NGÀY tổng hợp, không nhất thiết là ngày thật:
 *   time_value = DATE(year_to, 1, 1) + (year_to - year_from) ngày
 * Với layer snapshot 1 năm (year_from === year_to) → đúng ngày 1/1 năm đó.
 * Với layer so sánh giai đoạn (year_from !== year_to) → lệch đi vài chục ngày,
 * đủ để không bao giờ trùng giữa 2 giai đoạn khác nhau trong cùng 1 nhóm
 * (year_to + offset trùng ⇔ year_from cũng trùng ⇒ cùng 1 giai đoạn).
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const repo       = require('../repositories/layer-series.repository');
const geoserver  = require('../utils/geoserver.client');
const { isTiffBuffer } = require('../utils/geotiff.util');
const { Api400Error, Api404Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const computeTimeValue = (yearFrom, yearTo) => {
    const span = yearTo - yearFrom;
    const date = new Date(Date.UTC(yearTo, 0, 1));
    date.setUTCDate(date.getUTCDate() + span);
    return date;
};

const isoDate = (date) => date.toISOString().slice(0, 10);

const buildLabel = (yearFrom, yearTo, lang) => {
    if (yearFrom === yearTo) { return String(yearFrom); }
    return lang === 'en' ? `${yearFrom}-${yearTo}` : `${yearFrom}–${yearTo}`;
};

/**
 * Đảm bảo nhóm layer đã có CoverageStore ImageMosaic + time dimension trên
 * GeoServer. Idempotent — nếu đã publish (mosaic_path + geoserver_layer đã
 * set) thì trả về ngay, không gọi lại GeoServer.
 */
const ensureMosaic = async (groupCode, lang = 'vi') => {
    const layer = await repo.findGroupByCode(groupCode);
    if (!layer) {
        throw new Api404Error(t('layer_series_group_not_found', lang), ['LAYER_GROUP_NOT_FOUND']);
    }
    if (layer.mosaic_path && layer.geoserver_layer) { return layer; }

    const dataDir = process.env.GEOSERVER_DATA_DIR;
    if (!dataDir) {
        throw new Api400Error(t('layer_series_data_dir_missing', lang), ['RASTER_DIR_MISSING']);
    }

    const mosaicDir = path.join(dataDir, 'mosaics', groupCode);
    await fs.promises.mkdir(mosaicDir, { recursive: true });

    const geoserverLayer = await geoserver.publishTimelapseLayer({
        geoserver_store: groupCode,
        table_name:      groupCode,
        mosaic_path:     mosaicDir,
    }, lang);
    await geoserver.enableTimeDimension(groupCode);

    return repo.setMosaicPublished(null, {
        layerId: layer.id, mosaicPath: mosaicDir, geoserverLayer, geoserverStore: groupCode,
    });
};

/**
 * Thêm 1 GeoTIFF (1 năm hoặc 1 giai đoạn) vào chuỗi thời gian của 1 nhóm.
 *
 * @param {object} args
 * @param {string} args.group        — code nhóm (vd 'lop_phu')
 * @param {number|string} args.yearFrom
 * @param {number|string} [args.yearTo] — mặc định = yearFrom (snapshot 1 năm)
 * @param {Buffer} args.fileBuffer   — nội dung GeoTIFF (từ multer memory storage)
 * @param {object} [args.user]
 * @param {string} [args.lang]
 */
const ingestGranule = async ({ group, yearFrom, yearTo, fileBuffer, user, lang = 'vi' }) => {
    const yf = Number(yearFrom);
    const yt = (yearTo === undefined || yearTo === null || yearTo === '') ? yf : Number(yearTo);
    if (!Number.isInteger(yf) || !Number.isInteger(yt) || yf < 1900 || yf > 2100 || yt < yf || yt > 2100) {
        throw new Api400Error(t('layer_series_invalid_years', lang), ['INVALID_YEARS']);
    }
    if (!fileBuffer || !isTiffBuffer(fileBuffer)) {
        throw new Api400Error(t('layer_series_invalid_tiff', lang), ['INVALID_TIFF']);
    }

    const layer = await ensureMosaic(group, lang);

    const timeDate = computeTimeValue(yf, yt);
    const dateTag  = isoDate(timeDate);
    const filename = `${group}_${dateTag}.tif`;
    const destPath = path.join(layer.mosaic_path, filename);

    await fs.promises.writeFile(destPath, fileBuffer);
    const sha = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    await geoserver.harvestGeoTiff(group, destPath);
    if (layer.geoserver_layer) {
        await geoserver.truncateGwcLayer(layer.geoserver_layer).catch((err) => {
            console.warn(`[LAYER-SERIES] GWC truncate failed group=${group}: ${err.message}`);
        });
    }

    const granule = await repo.upsertGranule(null, {
        layerId:     layer.id,
        yearFrom:    yf,
        yearTo:      yt,
        timeValue:   dateTag,
        labelVi:     buildLabel(yf, yt, 'vi'),
        labelEn:     buildLabel(yf, yt, 'en'),
        filePath:    destPath,
        fileSha256:  sha,
        ingestedBy:  user?.id || null,
    });
    await repo.touchLastUpdated(layer.id);

    console.log(`[LAYER-SERIES] group=${group} ingested ${filename} time=${dateTag} by user=${user?.id || 'anon'}`);
    return granule;
};

const listTimesteps = async (groupCode, lang = 'vi') => {
    const layer = await repo.findGroupByCode(groupCode);
    if (!layer) {
        throw new Api404Error(t('layer_series_group_not_found', lang), ['LAYER_GROUP_NOT_FOUND']);
    }
    const granules = await repo.listGranules(layer.id);
    return granules.map((g) => ({
        year_from:       g.year_from,
        year_to:         g.year_to,
        label:           lang === 'en' ? (g.label_en || g.label_vi) : g.label_vi,
        time_value:      g.time_value,
        geoserver_layer: layer.geoserver_layer,
    }));
};

const listGroups = async (lang = 'vi') => {
    const rows = await repo.listGroups();
    return rows.map((r) => ({
        code:            r.code,
        name:            lang === 'en' ? (r.name_en || r.name_vi) : r.name_vi,
        geoserver_layer: r.geoserver_layer,
        last_updated_at: r.last_updated_at,
    }));
};

module.exports = {
    computeTimeValue, buildLabel, ensureMosaic, ingestGranule, listTimesteps, listGroups,
};
