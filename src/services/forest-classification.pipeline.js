'use strict';

/**
 * Shared 13-class Kon Tum forest classification pipeline — port từ
 * kontum_forest_classification_final.js v5.3.
 *
 * So với port v3 cũ:
 *   [v4.1-A] Roy et al. (2016) harmonize L5/L7 → OLI để chuỗi 1991→nay không gãy.
 *   [v4.1-B] Sentinel-2 dùng B8A (865 nm) thay B8 (842 nm) để trùng dải NIR Landsat.
 *   [v4.1-C] Master collection dựng MỘT LẦN per (start, end, year); các cửa sổ
 *            mùa (base/green/dry/defol/recent) filter từ master.
 *   [v4.1-D] 27-band feature image (v3: 26 bands): thêm drop/recov/dNBR/rec_NDVI/
 *            rec_NBR/f_NDVI/f_BSI/aspect_sin+cos/g_swir1.
 *   [v4.1-E] Threshold class 1 tách rubber (rụng lá Jan-Feb) + perennial (thường xanh).
 *   [v4.1-F] Priority mosaic đảo ngược: rừng (8/4/7/3/6/5) ĐÈ cây công nghiệp
 *            (class 1). Fix nguyên nhân class 1 dư +223.850 ha ở v3.
 *   [v4.1-G] naturalCore two-way exclusion: rừng tự nhiên phải KHÔNG chồng với
 *            class 1/2/10; đồng thời class 1/2/10 phải KHÔNG chồng naturalCore.
 *   [v4.1-H] [R1] Pixel không khớp lớp nào → class 0 (Đất khác). Không còn "lỗ trống".
 *   [v4.1-I] Sample quotas theo sqrt(AREA_PRIOR) — không đều 100/lớp. Lớp hiếm
 *            (< 20.000 ha) lấy thêm ở SAMPLE_SCALE_RARE_M.
 *   [v4.1-J] GT split theo spatial block 5000 m (không random điểm) — fix accuracy
 *            inflation của v3.
 *   [v4.1-K] ESA WorldCover CHỈ dùng đúng epoch (v100=2020, v200=2021).
 *   [v4.1-L] BỎ Dynamic World hoàn toàn — DW.trees gộp cả cao su/cà phê/keo/thông
 *            → không giúp phân biệt subtype rừng.
 *   [v4.1-M] Gate: nếu số lớp đủ MIN_TRAIN_PER_CLASS < GATE_NO_TRAIN thì KHÔNG train.
 *   [v4.1-N] Pin display scale = SAMPLE_SCALE (200 m) để bản đồ đúng với scale train.
 *
 * Public API giữ nguyên chữ ký v3 để service.js + satellite.service không phải
 * đổi tại chỗ. Tham số MỚI được thêm qua opts:
 *   - opts.month  (1-12): tháng anchor cho các cửa sổ mùa. Mặc định 12 (December).
 *
 * Consumed by:
 *   - forest-classification.service (cron monthly snapshot)
 *   - satellite.service (on-demand /satellite/classified)
 */

const cfg = require('../configs/forest-classification');
const { ee } = require('../configs/gge');
const { eeEval, eeGetInfo } = require('../utils/gee-satellite.util');
const { makeStageLogger } = require('../utils/stage-logger.util');

// ── Constants ────────────────────────────────────────────────────────────────

const BANDS = ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'];
// FALLBACK reflectance is lazy — ee.Image.constant chỉ được gọi khi pipeline chạy
// (ee module cần init xong trước). Nếu evaluate top-level, `require()` sẽ crash
// khi test/tools nạp module trong môi trường chưa khởi tạo GEE.
const getFallback = () => ee.Image.constant(cfg.FALLBACK_REFLECTANCE).rename(BANDS).toFloat();

// ── Preprocessing ────────────────────────────────────────────────────────────

function maskLandsatC2(img) {
    const qa = img.select('QA_PIXEL');
    return img.updateMask(
        qa.bitwiseAnd(1 << 0).eq(0)
            .and(qa.bitwiseAnd(1 << 1).eq(0))
            .and(qa.bitwiseAnd(1 << 3).eq(0))
            .and(qa.bitwiseAnd(1 << 4).eq(0))
            .and(qa.bitwiseAnd(1 << 5).eq(0)),
    );
}

// [v4.1-A] Roy et al. 2016: TM/ETM+ → OLI. Không có bước này thì chuỗi thời gian
// dài (1991 → nay) gãy tại 2013 khi Landsat 5/7 nghỉ.
function prepL57(img) {
    return img.select(['SR_B1', 'SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B7'], BANDS)
        .multiply(0.0000275).add(-0.2)
        .multiply(ee.Image.constant(cfg.ROY_SLOPE))
        .add(ee.Image.constant(cfg.ROY_ITCP))
        .clamp(0, 1).toFloat().rename(BANDS)
        .copyProperties(img, ['system:time_start']);
}

function prepL89(img) {
    return img.select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'], BANDS)
        .multiply(0.0000275).add(-0.2).clamp(0, 1).toFloat()
        .copyProperties(img, ['system:time_start']);
}

// [v4.1-B] S2_SR_HARMONIZED đã dịch ngược offset -1000 của baseline 04.00
// → chỉ chia 10000. NIR dùng B8A (865 nm) để TRÙNG DẢI với NIR Landsat.
function maskS2(img) {
    const scl = img.select('SCL');
    return img.select(['B2', 'B3', 'B4', 'B8A', 'B11', 'B12'], BANDS)
        .multiply(0.0001).clamp(0, 1).toFloat()
        .updateMask(
            scl.neq(1).and(scl.neq(3)).and(scl.neq(8))
                .and(scl.neq(9)).and(scl.neq(10)).and(scl.neq(11)),
        )
        .copyProperties(img, ['system:time_start']);
}

// [v4.1-C] Dựng master collection MỘT LẦN cho [start, end). Client-side dispatch
// theo year để tránh ee.Algorithms.If (tối ưu graph GEE).
function masterCollection(start, end, year, region) {
    const lsFilter = ee.Filter.lt('CLOUD_COVER', cfg.MAX_LS_CLOUD);

    let ic = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
        .filterBounds(region).filterDate(start, end).filter(lsFilter)
        .map(maskLandsatC2).map(prepL89)
        .merge(
            ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
                .filterBounds(region).filterDate(start, end).filter(lsFilter)
                .map(maskLandsatC2).map(prepL89),
        );

    if (year <= 2012) {
        ic = ic.merge(
            ee.ImageCollection('LANDSAT/LT05/C02/T1_L2')
                .filterBounds(region).filterDate(start, end).filter(lsFilter)
                .map(maskLandsatC2).map(prepL57),
        ).merge(
            // L7 SLC-off từ 31/05/2003 → chỉ dùng khi chưa có OLI (< 2013).
            ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
                .filterBounds(region).filterDate(start, end).filter(lsFilter)
                .map(maskLandsatC2).map(prepL57),
        );
    }

    if (year >= 2016) {
        ic = ic.merge(
            ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
                .filterBounds(region).filterDate(start, end)
                .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cfg.MAX_S2_CLOUD))
                .map(maskS2),
        );
    }

    return ic.select(BANDS);
}

// ── Safe indices (no division by zero, no implicit mask) ─────────────────────

function nd(img, a, b, name) {
    const A = img.select(a), B = img.select(b), den = A.add(B);
    return A.subtract(B)
        .divide(den.where(den.abs().lt(1e-6), 1e-6))
        .clamp(-1, 1).rename(name).toFloat();
}

function bsi(img, name) {
    return img.expression('((S+R)-(N+B))/((S+R)+(N+B)+1e-6)',
        {
            S: img.select('swir1'), R: img.select('red'),
            N: img.select('nir'),   B: img.select('blue'),
        }).clamp(-1, 1).rename(name).toFloat();
}

function evi(img, name) {
    return img.expression('2.5*(N-R)/(N+6*R-7.5*B+1)',
        {
            N: img.select('nir'), R: img.select('red'), B: img.select('blue'),
        }).clamp(-1, 2).rename(name).toFloat();
}

// ── Season windows (client-side) ─────────────────────────────────────────────

function seasonWindow(year, month, sm, em) {
    // Chọn lần gần nhất mà cửa sổ mùa kết thúc <= anchor month.
    const y = (em > month) ? year - 1 : year;
    return {
        y, s: sm, e: em,
        start: ee.Date.fromYMD(y, sm, 1),
        end:   ee.Date.fromYMD(y, em, 1).advance(1, 'month'),
        tag:   `${y}-${String(sm).padStart(2, '0')}`,
    };
}

// ── Feature image (27 bands) ─────────────────────────────────────────────────

function buildFeatureImage(year, month, region) {
    const anchorEnd = ee.Date.fromYMD(year, month, 1).advance(1, 'month');
    const baseStart = anchorEnd.advance(-cfg.WIN_BASE_MONTHS, 'month');
    const recStart  = anchorEnd.advance(-cfg.WIN_RECENT_MONTHS, 'month');

    const g = seasonWindow(year, month, cfg.WIN_GREEN_START, cfg.WIN_GREEN_END);
    const d = seasonWindow(year, month, cfg.WIN_DRY_START,   cfg.WIN_DRY_END);
    const f = seasonWindow(year, month, cfg.WIN_DEFOL_START, cfg.WIN_DEFOL_END);

    // Master phủ cả nền 12 tháng LẪN các cửa sổ mùa (mùa có thể lùi 1 năm).
    const masterStart = ee.Date(ee.Algorithms.If(
        g.start.difference(baseStart, 'day').lt(0), g.start, baseStart));

    const master = masterCollection(masterStart, anchorEnd, year, region);

    // Chuỗi lấp lỗ chỉ 1 tầng: mùa → nền 12 tháng → hằng số FALLBACK.
    const FALLBACK = getFallback();
    const baseRaw = master.filterDate(baseStart, anchorEnd).median().clip(region);
    const dataMask = baseRaw.mask().reduce(ee.Reducer.min()).rename('dataMask');
    const base  = baseRaw.unmask(FALLBACK).clamp(0, 1).toFloat();
    const green = master.filterDate(g.start, g.end).median()
        .clip(region).unmask(base).clamp(0, 1).toFloat();
    const dry   = master.filterDate(d.start, d.end).median()
        .clip(region).unmask(base).clamp(0, 1).toFloat();
    const defol = master.filterDate(f.start, f.end).median()
        .clip(region).unmask(base).clamp(0, 1).toFloat();
    const rec   = master.filterDate(recStart, anchorEnd).median()
        .clip(region).unmask(base).clamp(0, 1).toFloat();

    // Base indices — KHÔNG dùng NDBI (= -NDMI, trùng lặp hoàn toàn).
    const b_ndvi  = nd(base, 'nir', 'red',   'NDVI');
    const b_ndmi  = nd(base, 'nir', 'swir1', 'NDMI');
    const b_nbr   = nd(base, 'nir', 'swir2', 'NBR');
    const b_mndwi = nd(base, 'green', 'swir1', 'MNDWI');
    const b_bsi   = bsi(base, 'BSI');
    const b_evi   = evi(base, 'EVI');

    const g_ndvi  = nd(green, 'nir', 'red',   'g_NDVI');
    const g_ndmi  = nd(green, 'nir', 'swir1', 'g_NDMI');
    const g_nbr   = nd(green, 'nir', 'swir2', 'g_NBR');
    const g_evi   = evi(green, 'g_EVI');
    const g_swir1 = green.select('swir1').rename('g_swir1');
    const g_swir2 = green.select('swir2').rename('g_swir2');

    const d_ndvi  = nd(dry, 'nir', 'red',    'd_NDVI');
    const d_ndmi  = nd(dry, 'nir', 'swir1',  'd_NDMI');
    const d_mndwi = nd(dry, 'green', 'swir1', 'd_MNDWI');
    const d_bsi   = bsi(dry, 'd_BSI');

    const f_ndvi = nd(defol, 'nir', 'red', 'f_NDVI');
    const f_bsi  = bsi(defol, 'f_BSI');

    const amp   = g_ndvi.subtract(d_ndvi).rename('amp');
    const drop  = g_ndvi.subtract(f_ndvi).rename('drop');
    const recov = d_ndvi.subtract(f_ndvi).rename('recov');   // trục tách cao su

    const r_ndvi = nd(rec, 'nir', 'red',   'rec_NDVI');
    const r_nbr  = nd(rec, 'nir', 'swir2', 'rec_NBR');
    const dNBR   = b_nbr.subtract(r_nbr).rename('dNBR');

    const dem   = ee.Image('USGS/SRTMGL1_003').clip(region);
    const elev  = dem.rename('elevation').toFloat();
    const slope = ee.Terrain.slope(dem).rename('slope').toFloat();
    const asp   = ee.Terrain.aspect(dem).multiply(Math.PI / 180);
    const aspS  = asp.sin().rename('aspect_sin').toFloat();
    const aspC  = asp.cos().rename('aspect_cos').toFloat();

    const bandsOut = [
        b_ndvi, b_ndmi, b_nbr, b_mndwi, b_bsi, b_evi,
        g_ndvi, g_ndmi, g_nbr, g_evi, g_swir1, g_swir2,
        d_ndvi, d_ndmi, d_mndwi, d_bsi,
        f_ndvi, f_bsi, amp, drop, recov,
        r_ndvi, r_nbr, dNBR, elev, slope, aspS, aspC,
    ];

    // Texture chỉ bật cho ROI nhỏ (< 100 km²) qua env FC_USE_TEXTURE.
    if (cfg.USE_TEXTURE) {
        bandsOut.push(g_ndvi.reduceNeighborhood({
            reducer: ee.Reducer.stdDev(),
            kernel:  ee.Kernel.square({ radius: 1, units: 'pixels' }),
        }).rename('ndvi_sd').toFloat());
    }

    return {
        image: base.addBands(bandsOut).toFloat().clip(region),
        base,
        dataMask,
        hasTexture: cfg.USE_TEXTURE,
        windows: {
            base:   baseStart.format('YYYY-MM'),
            green:  g.tag, dry: d.tag, defol: f.tag,
            recent: recStart.format('YYYY-MM'),
        },
        nImages: master.size(),
    };
}

// ── Thresholds (13-class schema, v5.3) ───────────────────────────────────────

function buildThresholds(im, hasTexture, dwBuilt) {
    const B = (n) => im.select(n);
    const TRUE = ee.Image.constant(1);

    // Khi tắt texture, mọi điều kiện độ nhám tự suy biến thành TRUE.
    const sdLte = (x) => (hasTexture ? B('ndvi_sd').lte(x) : TRUE);
    const sdGte = (x) => (hasTexture ? B('ndvi_sd').gte(x) : TRUE);

    const ndmi = B('NDMI'), mndwi = B('MNDWI'), bsiB = B('BSI');
    const gN = B('g_NDVI'), gM = B('g_NDMI'), gB = B('g_NBR'),
        gE = B('g_EVI'), gS = B('g_swir1');
    const dN = B('d_NDVI'), dM = B('d_NDMI'), dW = B('d_MNDWI'), dB = B('d_BSI');
    const fN = B('f_NDVI'), fB = B('f_BSI');
    const amp = B('amp'), drop = B('drop'), recov = B('recov');
    const elev = B('elevation'), slope = B('slope');

    const T = {};

    T.water = mndwi.gte(0.10).and(gN.lte(0.30))
        .or(dW.gte(0.06).and(dN.lte(0.24)));

    T.other = gN.lte(0.48).and(ndmi.lte(0.10)).and(mndwi.lt(0.08))
        .or(dB.gte(0.02).and(gN.lte(0.55)).and(gM.lte(0.14)))
        .or(fB.gte(0.03).and(gN.lte(0.55)).and(ndmi.lte(0.06)));
    if (dwBuilt) T.other = T.other.or(dwBuilt.gte(cfg.DW_BUILT_MIN).and(gN.lte(0.68)));

    T.grass = gN.gte(0.28).and(gN.lte(0.74)).and(dN.lte(0.54))
        .and(amp.gte(0.06)).and(gM.lte(0.24)).and(gB.lte(0.48))
        .and(dB.gte(-0.12)).and(slope.lt(40));

    T.agri = amp.gte(0.16).and(fN.lte(0.55)).and(dN.lte(0.60))
        .and(gN.gte(0.40)).and(recov.lte(0.14))
        .and(dB.gte(-0.08)).and(dM.lte(0.14)).and(mndwi.lt(0.06))
        .and(elev.lt(1300)).and(slope.lt(30));

    T.rubber = fN.lte(0.62).and(recov.gte(0.06))
        .and(gN.gte(0.54)).and(gN.lte(0.92))
        .and(elev.lte(1000)).and(slope.lte(24))
        .and(mndwi.lt(0.05)).and(sdLte(0.06));

    T.perennial = gN.gte(0.48).and(gN.lte(0.90))
        .and(dN.gte(0.40)).and(amp.lte(0.26))
        .and(elev.gte(320)).and(elev.lte(1250)).and(slope.lte(22))
        .and(gM.lte(0.28)).and(gE.lte(0.52)).and(gB.lte(0.50))
        .and(sdLte(0.05));

    T.industrial = T.rubber.or(T.perennial);

    const evClosed = gN.gte(0.70).and(fN.gte(0.62)).and(dN.gte(0.62))
        .and(amp.lte(0.13)).and(recov.abs().lte(0.07))
        .and(gE.gte(0.34)).and(gM.gte(0.28)).and(dM.gte(0.12))
        .and(gB.gte(0.44)).and(bsiB.lte(-0.08)).and(elev.gte(200));
    const evSecondary = gN.gte(0.62).and(gN.lt(0.72))
        .and(fN.gte(0.56)).and(dN.gte(0.56))
        .and(amp.lte(0.16)).and(recov.abs().lte(0.08))
        .and(gM.gte(0.18)).and(gM.lte(0.32))
        .and(gE.gte(0.26)).and(gB.gte(0.36))
        .and(gS.lte(0.072)).and(elev.gte(200));
    T.evergreen = evClosed.or(evSecondary);

    T.mixed = elev.gte(880).and(elev.lte(1950))
        .and(gN.gte(0.58)).and(gN.lte(0.88))
        .and(dN.gte(0.54)).and(amp.lte(0.16))
        .and(gM.gte(0.16)).and(gM.lte(0.35))
        .and(gE.gte(0.24)).and(gE.lte(0.46))
        .and(gS.gte(0.054)).and(gS.lte(0.118)).and(slope.gte(9));

    T.conifer = elev.gte(900).and(slope.gte(11))
        .and(gN.gte(0.44)).and(gN.lte(0.76))
        .and(dN.gte(0.42)).and(amp.lte(0.17))
        .and(gE.gte(0.15)).and(gE.lte(0.38))
        .and(gM.gte(0.06)).and(gM.lte(0.30))
        .and(gS.gte(0.072)).and(gB.gte(0.18)).and(gB.lte(0.54))
        .and(sdGte(0.028));

    // 515,55 ha toàn tỉnh — giữ chặt để KHÔNG phóng đại như v3 (9.219 ha).
    T.deciduous = fN.lte(0.40).and(dN.lte(0.46)).and(gN.gte(0.65))
        .and(drop.gte(0.30)).and(recov.lte(0.08))
        .and(elev.lte(800)).and(slope.gte(3))
        .and(gB.gte(0.40)).and(gM.gte(0.20)).and(fB.gte(0.02))
        .and(sdGte(0.04));

    // Bao gồm cả ~52.627 ha hỗn giao gỗ-tre nứa (schema không có lớp riêng).
    T.bamboo = gN.gte(0.60).and(gN.lte(0.88))
        .and(dN.gte(0.42)).and(dN.lte(0.78))
        .and(amp.gte(0.08)).and(amp.lte(0.28)).and(recov.lte(0.12))
        .and(gM.gte(0.10)).and(gM.lte(0.32))
        .and(gE.gte(0.24)).and(gE.lte(0.48)).and(gB.gte(0.34))
        .and(gS.gte(0.048)).and(gS.lte(0.078))
        .and(elev.gte(250)).and(elev.lte(1400)).and(slope.gte(5))
        .and(sdGte(0.033));

    // 85 % là thông ba lá TRỒNG (20.174 ha) → phổ trùng lớp 5 nên tách theo elev.
    const plantPine = elev.gte(800).and(elev.lte(1500)).and(slope.lte(12))
        .and(gN.gte(0.50)).and(gN.lte(0.76)).and(amp.lte(0.13))
        .and(gS.gte(0.078)).and(gE.lte(0.34)).and(gM.lte(0.24))
        .and(sdLte(0.045));
    const plantBroad = gN.gte(0.66).and(gN.lte(0.86))
        .and(dN.gte(0.48)).and(amp.lte(0.16))
        .and(elev.lte(600)).and(slope.lte(10))
        .and(gS.gte(0.064)).and(gM.lte(0.24)).and(gB.gte(0.36))
        .and(sdLte(0.040));
    T.plantation = plantPine.or(plantBroad);

    // [v4.1-G] naturalCore — hai chiều loại trừ (không phải nonNatural.NOT()
    // một chiều của v3 khiến class 1 dư +223.850 ha).
    T.naturalCore = fN.gte(0.60).and(dN.gte(0.60)).and(gM.gte(0.25))
        .and(amp.lte(0.16)).and(recov.abs().lte(0.08)).and(gB.gte(0.38));

    return T;
}

// ── Two-pass label: hard masks, then weighted score for residual pixels ───────

function score(conds) {
    let num = ee.Image.constant(0);
    let den = 0;
    conds.forEach(({ c, w }) => {
        num = num.add(c.multiply(w));
        den += w;
    });
    return num.divide(den).toFloat();
}

function buildRelaxedLabel(im, naturalCore, dwBuilt) {
    const B = (n) => im.select(n);
    const btw = (b, lo, hi) => b.gte(lo).and(b.lte(hi));
    const ndmi = B('NDMI'), mndwi = B('MNDWI');
    const gN = B('g_NDVI'), gM = B('g_NDMI'), gB = B('g_NBR');
    const gE = B('g_EVI'), gS = B('g_swir1');
    const dN = B('d_NDVI'), dM = B('d_NDMI'), dB = B('d_BSI');
    const fN = B('f_NDVI');
    const amp = B('amp'), drop = B('drop'), recov = B('recov');
    const elev = B('elevation'), slope = B('slope');
    const notCore = naturalCore.not();
    const notWater = mndwi.lt(0.06);
    const S = {};

    const c1 = [
        { c: gN.lte(0.62), w: 2 }, { c: ndmi.lte(0.18), w: 2 },
        { c: dB.gte(-0.04), w: 1 }, { c: notWater, w: 1 },
        { c: amp.lte(0.40), w: 1 },
    ];
    if (dwBuilt) c1.push({ c: dwBuilt.gte(0.06), w: 3 });
    S[1] = score(c1).multiply(notCore);
    S[2] = score([
        { c: btw(gN, 0.46, 0.92), w: 1 }, { c: dN.gte(0.36), w: 1 },
        { c: gM.lte(0.29), w: 3 }, { c: btw(elev, 300, 1300), w: 1 },
        { c: slope.lte(24), w: 2 }, { c: recov.gte(0.04).or(amp.lte(0.24)), w: 2 },
    ]).multiply(notCore);
    S[3] = score([
        { c: amp.gte(0.10), w: 2 }, { c: dN.lte(0.60), w: 2 },
        { c: gN.gte(0.38), w: 1 }, { c: elev.lte(1300), w: 1 },
        { c: slope.lte(30), w: 1 }, { c: dM.lte(0.16), w: 1 },
        { c: notWater, w: 1 },
    ]).multiply(notCore);
    S[4] = score([
        { c: elev.gte(880), w: 2 }, { c: btw(gN, 0.56, 0.88), w: 1 },
        { c: amp.lte(0.18), w: 1 }, { c: btw(gM, 0.15, 0.35), w: 1 },
        { c: btw(gS, 0.054, 0.118), w: 2 },
    ]);
    S[5] = score([
        { c: btw(gN, 0.60, 0.95), w: 1 }, { c: fN.gte(0.54), w: 2 },
        { c: dN.gte(0.54), w: 2 }, { c: amp.lte(0.17), w: 1 },
        { c: gM.gte(0.17), w: 2 }, { c: gS.lte(0.074), w: 3 },
        { c: gB.gte(0.34), w: 1 },
    ]);
    S[6] = score([
        { c: elev.gte(900), w: 2 }, { c: gS.gte(0.070), w: 3 },
        { c: gE.lte(0.38), w: 2 }, { c: btw(gN, 0.42, 0.78), w: 1 },
        { c: amp.lte(0.18), w: 1 }, { c: slope.gte(9), w: 1 },
    ]);
    S[7] = score([
        { c: fN.lte(0.48), w: 2 }, { c: drop.gte(0.24), w: 2 },
        { c: recov.lte(0.12), w: 1 }, { c: elev.lte(900), w: 1 },
        { c: gN.gte(0.58), w: 1 },
    ]);
    S[8] = score([
        { c: btw(gN, 0.58, 0.90), w: 1 }, { c: btw(amp, 0.07, 0.30), w: 2 },
        { c: btw(gM, 0.09, 0.33), w: 2 }, { c: gB.gte(0.32), w: 2 },
        { c: btw(gS, 0.046, 0.080), w: 2 }, { c: btw(elev, 250, 1450), w: 1 },
        { c: slope.gte(4), w: 1 },
    ]);
    S[9] = score([
        { c: gS.gte(0.076), w: 3 }, { c: btw(gN, 0.48, 0.84), w: 1 },
        { c: amp.lte(0.18), w: 1 }, { c: slope.lte(13), w: 2 },
        { c: gM.lte(0.26), w: 2 }, { c: gE.lte(0.36), w: 2 },
    ]);
    S[11] = score([
        { c: btw(gN, 0.24, 0.76), w: 1 }, { c: amp.gte(0.05), w: 1 },
        { c: gM.lte(0.26), w: 3 }, { c: gB.lte(0.50), w: 2 },
        { c: dN.lte(0.58), w: 1 }, { c: slope.lt(40), w: 1 },
        { c: notWater, w: 1 },
    ]).multiply(notCore);

    let best = ee.Image.constant(0).toFloat();
    let classId = ee.Image.constant(cfg.UNKNOWN_ID).toInt16();
    [9, 8, 6, 4, 5, 3, 1, 11, 2, 7].forEach((id) => {
        const wins = S[id].gte(best).and(S[id].gte(cfg.MIN_SCORE));
        classId = classId.where(wins, id);
        best = best.max(S[id]);
    });
    return classId.rename('class').toInt16();
}

function buildLabel(im, T, dwBuilt, region) {
    const core = T.naturalCore;
    const c10 = T.water, c1 = T.other;
    const c2 = T.industrial.and(core.not());
    const c3 = T.agri.and(core.not());
    const c11 = T.grass.and(core.not());
    const keep = c1.or(c10).or(c2).or(c3).or(c11).not();
    const order = [
        { v: 1, m: c1 }, { v: 11, m: c11 }, { v: 3, m: c3 }, { v: 2, m: c2 },
        { v: 9, m: T.plantation.and(keep) }, { v: 6, m: T.conifer.and(keep) },
        { v: 5, m: T.evergreen.and(keep) }, { v: 8, m: T.bamboo.and(keep) },
        { v: 4, m: T.mixed.and(keep) }, { v: 7, m: T.deciduous.and(keep) },
        { v: 10, m: c10 },
    ];
    const hard = ee.ImageCollection(order.map(({ v, m }) =>
        ee.Image.constant(v).toInt16().updateMask(m),
    )).mosaic().rename('class').toInt16();
    return {
        label: hard.unmask(buildRelaxedLabel(im, core, dwBuilt)).clip(region),
        hardMask: hard.mask(),
    };
}

// ── buildPriorityLabel — kept for backwards compatibility ────────────────────

function buildPriorityLabel(entries, region) {
    const layers = entries.map(({ classValue, mask }) =>
        ee.Image.constant(classValue).toInt16().updateMask(mask),
    );
    return ee.ImageCollection(layers).mosaic()
        .rename('class').toInt16().clip(region);
}

// ── External priors (only water — DW removed in v4.1) ────────────────────────

function permanentWater(region) {
    const jrc = ee.Image('JRC/GSW1_4/GlobalSurfaceWater');
    return jrc.select('occurrence').unmask(0).gte(70)
        .and(jrc.select('recurrence').unmask(0).gte(70))
        .rename('perm_water').clip(region);
}

function dynamicWorldBuiltFraction(year, region) {
    if (!cfg.USE_DW_BUILT || year < 2016) return null;
    const dw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
        .filterBounds(region)
        .filterDate(ee.Date.fromYMD(year, 1, 1), ee.Date.fromYMD(year + 1, 1, 1));
    return ee.Image(ee.Algorithms.If(
        dw.size().gt(0), dw.select('built').mean().unmask(0), ee.Image.constant(0),
    )).rename('dw_built').clip(region);
}

function otherLandMask(region, assetId = cfg.OTHER_LAND_ASSET) {
    if (!assetId) return null;
    return ee.Image().byte().paint(ee.FeatureCollection(assetId), 1)
        .unmask(0).gt(0).rename('other_land').clip(region);
}

// [v4.1-K] WorldCover CHỈ dùng đúng epoch — v3 gán cho mọi năm 2019-2023 là
// so ảnh với nhãn lệch năm. Trả null khi năm không có epoch tương ứng.
function worldCoverForYear(year) {
    if (year === 2020) {
        return ee.Image(ee.ImageCollection('ESA/WorldCover/v100').first()).select('Map');
    }
    if (year === 2021) {
        return ee.Image(ee.ImageCollection('ESA/WorldCover/v200').first()).select('Map');
    }
    return null;
}

// ── Sample quotas ────────────────────────────────────────────────────────────

// [v4.1-I] Phân bổ căn bậc hai diện tích. Lớp trội không "hút" hết ngân sách,
// lớp hiếm vẫn nhận đủ mẫu để RF không bỏ qua.
function computeQuotas(budget) {
    const roots = cfg.AREA_PRIOR.map((area, classId) =>
        cfg.NO_TRAIN_CLASSES.includes(classId) ? 0 : Math.sqrt(area));
    const sum = roots.reduce((a, b) => a + b, 0);
    return roots.map((r, classId) =>
        cfg.NO_TRAIN_CLASSES.includes(classId) ? 0 : Math.max(cfg.SAMPLE_MIN,
            Math.min(cfg.SAMPLE_MAX, Math.round(budget * r / sum))),
    );
}

// ── Sampling ─────────────────────────────────────────────────────────────────

function sampleLabel(img, label, values, points, region, scale, seed, excl, src) {
    const cb = label.rename('class').toInt16();
    let bands = img.addBands(cb).updateMask(cb.mask());
    if (excl) bands = bands.updateMask(excl);
    return bands.stratifiedSample({
        numPoints:   0,
        classBand:   'class',
        classValues: values,
        classPoints: points,
        region,
        scale,
        seed,
        geometries:  true,
        tileScale:   cfg.TILE_SCALE,
        dropNulls:   true,
    }).map((f) => f.set('src', src));
}

// [v4.1-J] Chia GT theo KHỐI KHÔNG GIAN — random điểm khiến train/test cùng
// lô, cùng cây, cách nhau vài chục mét → accuracy "ảo".
function addSpatialBlock(f) {
    const c = f.geometry().centroid(10).coordinates();
    const x = ee.Number(c.get(0)).multiply(111320).divide(cfg.GT_BLOCK_M).floor();
    const y = ee.Number(c.get(1)).multiply(110540).divide(cfg.GT_BLOCK_M).floor();
    const id = x.multiply(100000).add(y);
    const h = id.multiply(0.6180339887).add(0.31415926).sin().multiply(43758.5453);
    return f.set({ block_id: id, block_rand: h.subtract(h.floor()) });
}

function sampleGT(img, fc, points, region, scale, seed, split) {
    const ci = ee.Image().byte().paint(fc, 'class').rename('class').toInt16();
    return img.addBands(ci).updateMask(ci.mask()).stratifiedSample({
        numPoints:   0,
        classBand:   'class',
        classValues: ee.List.sequence(0, cfg.CLASS_NAMES.length - 1),
        classPoints: points,
        region,
        scale,
        seed,
        geometries:  true,
        tileScale:   cfg.TILE_SCALE,
        dropNulls:   true,
    }).map((f) => f.set({ src: 'gt', split }));
}

function buildExclusionMask(gtFC, bufferM, region) {
    if (!bufferM || bufferM <= 0) return null;
    const buffered = gtFC.map((f) => f.buffer(bufferM));
    return ee.Image().byte().paint(buffered, 1).unmask(0).not().clip(region);
}

// ── Legacy exports kept for satellite-service imports (v3 compat) ────────────

function buildThresholdLabel(base, dryIdx, wetIdx, dem, region) {
    // Adaptor mỏng cho v3 caller. v4.1 build thresholds trực tiếp từ 27-band
    // feature image trong `runRfClassification`, không cần dryIdx/wetIdx riêng.
    // Callers cũ chỉ dùng shape output (single-band label image) nên trả về
    // một image với single band `class` bằng cách chạy naturalCore over feature.
    // Ở đây chọn cách đơn giản: dùng base + dry + wet để dựng lại image mini.
    // Nếu ai đó vẫn gọi hàm này ngoài pipeline, cảnh báo trước.
    // eslint-disable-next-line no-console
    console.warn('[FOREST-CLS] buildThresholdLabel legacy shim — pipeline v4.1 đã tự dựng threshold trong runRfClassification');
    void base; void dryIdx; void wetIdx; void dem;
    return ee.Image.constant(0).rename('class').toInt16().clip(region);
}

function buildDatasetLabel(featureImage, thresholdLabel, year, region) {
    // v4.1 đã BỎ Dynamic World hoàn toàn (comment [v4.1-L]). Trả về threshold
    // label không thay đổi để callers cũ vẫn hoạt động.
    // eslint-disable-next-line no-console
    console.warn('[FOREST-CLS] buildDatasetLabel legacy shim — pipeline v4.1 đã bỏ DW/WorldCover epoch-lệch');
    void featureImage; void year; void region;
    return thresholdLabel;
}

function sampleFromLabel(featureImage, labelImage, nSamples, regionGeom, seed, exclusionMask, scaleM) {
    // v3 API adaptor → gọi v4.1 sampleLabel với quotas đều.
    const values = ee.List.sequence(0, cfg.CLASS_NAMES.length - 1);
    const points = ee.List.repeat(nSamples, cfg.CLASS_NAMES.length);
    return sampleLabel(featureImage, labelImage, values, points,
        regionGeom, scaleM || cfg.SAMPLE_SCALE_M, seed, exclusionMask, 'threshold');
}

function sampleGroundTruth(featureImage, gtFC, nSamplesPerClass, regionGeom, seed) {
    // v3 API adaptor — v4.1 dùng sampleGT nội bộ với split label.
    const points = new Array(cfg.CLASS_NAMES.length).fill(nSamplesPerClass);
    return sampleGT(featureImage, gtFC, points, regionGeom, cfg.SAMPLE_SCALE_M, seed, 'gt');
}

// ── Main runner ──────────────────────────────────────────────────────────────

const MAX_INT32 = 2147483647;
const clampSeed = (n) => Math.abs(n) % MAX_INT32;

/**
 * Full v5.3 RF classification pipeline for one (year, month) over a region.
 * Returns the classified image + OOB + intermediates.
 *
 * @param {number} year
 * @param region        ee.FeatureCollection or ee.Geometry
 * @param regionGeom    ee.Geometry (pass region.geometry() if FC)
 * @param {object} opts
 * @param {number} [opts.month=12]                Anchor month (1-12) for season windows.
 * @param {number} [opts.seed]                    RF seed (default: year*100+month).
 * @param {string} [opts.groundTruthAssetId='']   GEE FC asset with `class` property.
 * @param {object} [opts.groundTruthGeoJson=null] Inline GeoJSON FC (higher priority than asset).
 * @param {number} [opts.gtBufferM]               GT exclusion radius; defaults to cfg.GT_BUFFER_M.
 * @param {number} [opts.minFieldTest=10]         Min GT test samples/class.
 * @param {boolean} [opts.skipStats=false]        Skip OOB + test metrics.
 * @param {boolean} [opts.computeOob]             Override skipStats for OOB.
 * @param {boolean} [opts.computeTestMetrics]     Override skipStats for test metrics.
 * @param {object}  [opts.logger]                 Stage logger reuse.
 * @param {boolean} [opts.liteMode=false]         Reduced budget + no external priors.
 */
async function runRfClassification(year, region, regionGeom, opts = {}) {
    const {
        month = 12,
        seed,
        groundTruthAssetId = '',
        groundTruthGeoJson = null,
        otherLandAssetId = cfg.OTHER_LAND_ASSET,
        gtBufferM = cfg.GT_BUFFER_M,
        minFieldTest = 10,
        skipStats = false,
        computeOob,
        computeTestMetrics,
        logger,
        liteMode = false,
    } = opts;

    const shouldComputeOob = computeOob ?? !skipStats;
    const shouldComputeTestMetrics = computeTestMetrics ?? !skipStats;
    const rfSeed = clampSeed(seed ?? (year * 100 + month));
    const hasGT = Boolean(groundTruthGeoJson?.features?.length || groundTruthAssetId);

    const sampleBudget = liteMode ? cfg.LITE_SAMPLE_BUDGET : cfg.SAMPLE_BUDGET;
    const useExternalPriors = !liteMode || cfg.LITE_USE_DATASET_LABELS;
    const rfTrees = liteMode ? cfg.LITE_RF_TREES : cfg.RF_TREES;

    const log = logger || makeStageLogger(
        liteMode ? 'FOREST-CLS-RF-LITE' : 'FOREST-CLS-RF',
        { correlationId: `${year}-${String(month).padStart(2, '0')}` },
    );

    // ── Feature image ────────────────────────────────────────────────────
    const F = await log.run(
        'Build 27-band feature image (base+green+dry+defol+recent + DEM) [LAZY]',
        () => Promise.resolve(buildFeatureImage(year, month, region)),
        { note: `WIN base=${cfg.WIN_BASE_MONTHS}mo green=${cfg.WIN_GREEN_START}-${cfg.WIN_GREEN_END} dry=${cfg.WIN_DRY_START}-${cfg.WIN_DRY_END} defol=${cfg.WIN_DEFOL_START}-${cfg.WIN_DEFOL_END}` },
    );
    const image = F.image;
    const base  = F.base;

    // ── Thresholds + label ───────────────────────────────────────────────
    const dwBuilt = dynamicWorldBuiltFraction(year, region);
    const otherLand = otherLandMask(region, otherLandAssetId);
    const otherLandOverride = otherLand || ee.Image.constant(0).clip(region);
    const T = await log.run(
        'Build v5.3 13-class thresholds (naturalCore two-way exclusion) [LAZY]',
        () => Promise.resolve(buildThresholds(image, F.hasTexture, dwBuilt)),
    );

    const pw = await log.run(
        'Build permanent-water override (JRC GSW occ≥70 ∧ rec≥70) [LAZY]',
        () => Promise.resolve(permanentWater(region)),
    );

    const wc = useExternalPriors ? worldCoverForYear(year) : null;

    const labelResult = await log.run(
        'Build hard masks + residual score + no-data/land/water overrides [LAZY]',
        () => Promise.resolve(buildLabel(image, T, dwBuilt, region)),
    );
    let label = labelResult.label.where(pw, 10);
    if (otherLand) label = label.where(otherLand, 1);
    label = label.where(F.dataMask.not(), cfg.NODATA_ID).rename('class').toInt16();
    log.mark('v5.3 priors',
        `DynamicWorld built=${Boolean(dwBuilt)} otherLandAsset=${Boolean(otherLandAssetId)} minScore=${cfg.MIN_SCORE}`);
    // ── Sample quotas ────────────────────────────────────────────────────
    const quotasPerClass = computeQuotas(sampleBudget);   // length 13
    // Rare classes get an extra pass at finer scale.
    const rareIdx = [];
    for (let i = 0; i < cfg.AREA_PRIOR.length; i++) {
        if (!cfg.NO_TRAIN_CLASSES.includes(i) && cfg.AREA_PRIOR[i] > 0 && cfg.AREA_PRIOR[i] < 20000) rareIdx.push(i);
    }

    log.mark(liteMode ? 'RF quotas (LITE)' : 'RF quotas',
        `hasGT=${hasGT} budget=${sampleBudget} sqrtQuota=[${quotasPerClass.join(',')}] rare=${JSON.stringify(rareIdx)} trees=${rfTrees}`);

    // ── Ground-truth split + exclusion mask ──────────────────────────────
    let gtTrainFC = null;
    let gtTestFC  = null;
    let excl      = ee.Image.constant(1).clip(region);

    if (hasGT) {
        const gtDesc = groundTruthGeoJson
            ? `inlineGeoJson(${groundTruthGeoJson.features.length} features)`
            : `asset=${groundTruthAssetId}`;
        await log.run(
            `Build GT with spatial-block split (block=${cfg.GT_BLOCK_M}m) [LAZY]`,
            async () => {
                let gtFC;
                if (groundTruthGeoJson) {
                    const eeFeats = groundTruthGeoJson.features.map((f) => {
                        const p = f.properties || {};
                        return ee.Feature(f.geometry,
                            { class: p.class ?? p.classId ?? p.class_id });
                    });
                    gtFC = ee.FeatureCollection(eeFeats).filter(ee.Filter.notNull(['class']));
                } else {
                    gtFC = ee.FeatureCollection(groundTruthAssetId)
                        .filter(ee.Filter.notNull(['class']));
                }
                const gt = gtFC.map(addSpatialBlock);
                gtTrainFC = gt.filter(ee.Filter.lt('block_rand',  cfg.GT_TRAIN_FRAC));
                gtTestFC  = gt.filter(ee.Filter.gte('block_rand', cfg.GT_TRAIN_FRAC));

                excl = ee.Image().byte()
                    .paint(gt.map((f) => f.buffer(gtBufferM)), 1)
                    .unmask(0).not().clip(region);
            },
            { note: gtDesc },
        );
    }

    // ── Threshold pool + rare booster (+ GT training merge) ──────────────
    const allValues = ee.List.sequence(0, cfg.CLASS_NAMES.length - 1);
    // hasGT: chỉ dùng 50 % quota cho threshold (còn lại cho GT).
    const thrQuota = hasGT ? quotasPerClass.map((n) => Math.round(n * 0.5)) : quotasPerClass.slice();

    let trainSet = await log.run(
        `Sample threshold pool (${thrQuota.reduce((a, b) => a + b, 0)} pts) [LAZY]`,
        () => Promise.resolve(sampleLabel(image, label, allValues, thrQuota,
            regionGeom, cfg.SAMPLE_SCALE_M, clampSeed(rfSeed * 100 + 1), excl, 'threshold')),
        { note: `scale=${cfg.SAMPLE_SCALE_M}m tileScale=${cfg.TILE_SCALE}` },
    );

    if (rareIdx.length) {
        const rarePoints = rareIdx.map((i) => thrQuota[i]);
        const rareSet = await log.run(
            `Sample rare-class pool (${rarePoints.reduce((a, b) => a + b, 0)} pts @ ${cfg.SAMPLE_SCALE_RARE_M}m) [LAZY]`,
            () => Promise.resolve(sampleLabel(image, label, rareIdx, rarePoints,
                regionGeom, cfg.SAMPLE_SCALE_RARE_M, clampSeed(rfSeed * 100 + 7), excl, 'threshold_rare')),
        );
        trainSet = trainSet.merge(rareSet);
    }

    let inputTestSamples = ee.FeatureCollection([]);
    if (hasGT) {
        const gtTrainPoints = quotasPerClass.slice();
        const gtTrainSet = await log.run(
            'Sample GT-train (spatially split, exclusion-free) [LAZY]',
            () => Promise.resolve(sampleGT(image, gtTrainFC, gtTrainPoints,
                regionGeom, cfg.SAMPLE_SCALE_RARE_M, clampSeed(rfSeed + 501), 'train')),
        );
        trainSet = trainSet.merge(gtTrainSet);

        const gtTestPoints = quotasPerClass.map((n) => Math.max(minFieldTest, Math.round(n * 0.4)));
        inputTestSamples = await log.run(
            'Sample GT-test (spatially split holdout) [LAZY]',
            () => Promise.resolve(sampleGT(image, gtTestFC, gtTestPoints,
                regionGeom, cfg.SAMPLE_SCALE_RARE_M, clampSeed(rfSeed + 502), 'test')),
        );
    }

    // ── [v4.1-M] Gate: đủ MIN_TRAIN_PER_CLASS × GATE_NO_TRAIN mới train RF ──
    let classifier    = null;
    let oobPct        = null;
    let rfSkipReason  = null;
    let classified    = null;
    let sampleHist    = null;

    if (shouldComputeOob || !skipStats) {
        // Materialize sample histogram để guard train.
        try {
            sampleHist = await log.run(
                'GETINFO sample histogram (guard MIN_TRAIN_PER_CLASS × GATE_NO_TRAIN)',
                () => eeGetInfo(trainSet.aggregate_histogram('class'), cfg.GEE_TIMEOUT_MS),
                { note: `min/class=${cfg.MIN_TRAIN_PER_CLASS} gate=${cfg.GATE_NO_TRAIN} classes` },
            );
        } catch (err) {
            log.mark('⚠ Sample histogram failed', err.message);
            sampleHist = null;
        }
        if (sampleHist) {
            const present = [];
            for (let k = 0; k < cfg.CLASS_NAMES.length; k++) {
                if (cfg.NO_TRAIN_CLASSES.includes(k)) continue;
                const n = Number(sampleHist[String(k)] || 0);
                if (n >= cfg.MIN_TRAIN_PER_CLASS) present.push(k);
            }
            log.mark('Sample coverage',
                `present=${present.length}/${cfg.CLASS_NAMES.length} classes ≥ ${cfg.MIN_TRAIN_PER_CLASS}`);
            if (present.length < cfg.GATE_NO_TRAIN) {
                rfSkipReason = `Only ${present.length} classes have ≥ ${cfg.MIN_TRAIN_PER_CLASS} samples (< GATE_NO_TRAIN=${cfg.GATE_NO_TRAIN})`;
                log.mark('⛔ RF skipped', rfSkipReason);
            }
        }
    }

    if (!rfSkipReason) {
        classifier = await log.run(
            'Assemble RF classifier graph (train + explain deferred) [LAZY]',
            () => Promise.resolve(
                ee.Classifier.smileRandomForest({
                    numberOfTrees:     rfTrees,
                    variablesPerSplit: cfg.RF_VARIABLES_PER_SPLIT,
                    minLeafPopulation: cfg.RF_MIN_LEAF_POPULATION,
                    bagFraction:       cfg.RF_BAG_FRACTION,
                    seed:              rfSeed,
                }).train({
                    features:        trainSet,
                    classProperty:   'class',
                    inputProperties: image.bandNames(),
                }),
            ),
            { note: `trees=${rfTrees} bag=${cfg.RF_BAG_FRACTION}` },
        );

        classified = await log.run(
            'Classify + JRC permanent-water override [LAZY]',
            () => Promise.resolve(
                image.classify(classifier).rename('classification').toByte()
                    .where(pw, 10)
                    .where(otherLandOverride, 1)
                    .where(F.dataMask.not(), cfg.NODATA_ID).clip(region),
            ),
        );

        if (shouldComputeOob) {
            oobPct = await log.run(
                'GETINFO OOB accuracy (forces sampling + RF training on EE)',
                async () => {
                    const diagnostics = ee.Dictionary(classifier.explain())
                        .select(['outOfBagErrorEstimate']);
                    const info = await eeGetInfo(diagnostics, cfg.OOB_TIMEOUT_MS);
                    const oobError = Number(info?.outOfBagErrorEstimate);
                    if (!Number.isFinite(oobError)) {
                        throw new Error('GEE classifier diagnostics did not return outOfBagErrorEstimate');
                    }
                    const pct = Math.max(0, Math.min(100, (1 - oobError) * 100));
                    if (oobError < 0.05) {
                        log.mark('⚠ OOB > 95% khi không có GT',
                            'DẤU HIỆU XẤU: RF đang học thuộc bộ ngưỡng, không học hiện trạng rừng');
                    }
                    return pct;
                },
                { note: `timeout=${cfg.OOB_TIMEOUT_MS}ms` },
            );
            log.mark('OOB accuracy', `${oobPct != null ? oobPct.toFixed(2) : 'null'}%`);
        }
    } else {
        // RF skipped — fallback là nhãn hai lượt (residual có thể là class 12).
        classified = await log.run(
            'FALLBACK — output threshold label (RF skipped by gate) [LAZY]',
            () => Promise.resolve(label.rename('classification').toByte()
                .where(pw, 10)
                .where(otherLandOverride, 1)
                .where(F.dataMask.not(), cfg.NODATA_ID).clip(region)),
        );
    }

    // ── Independent test accuracy (GT holdout) ───────────────────────────
    let testAccuracyPct = null;
    let testKappa       = null;
    if (shouldComputeTestMetrics && hasGT && classifier) {
        await log.run(
            'EVALUATE independent test accuracy + kappa (spatial-block GT holdout)',
            async () => {
                const classOrder = ee.List.sequence(0, cfg.CLASS_NAMES.length - 1);
                const validated  = inputTestSamples.classify(classifier);
                const matrix     = validated.errorMatrix('class', 'classification', classOrder);
                const testSize   = await eeEval(inputTestSamples.size());
                if (testSize > 0) {
                    testAccuracyPct = await eeEval(ee.Number(matrix.accuracy()).multiply(100));
                    testKappa       = await eeEval(matrix.kappa());
                    log.mark('Test metrics',
                        `acc=${testAccuracyPct != null ? testAccuracyPct.toFixed(2) : 'null'}% kappa=${testKappa != null ? testKappa.toFixed(3) : 'null'}`);
                } else {
                    log.mark('Test metrics', 'testSize=0 (no GT points survived spatial block split)');
                }
            },
        );
    }

    // Pin display scale = SAMPLE_SCALE để bản đồ đúng với cái đã học.
    // GIỮ tham chiếu `classifiedNative` (chưa reproject) cho consumer nào cần
    // materialize ở scale khác (VD getDownloadURL 500m) — reproject 200m ép GEE
    // compute RF chain ở 240k pixel Kon Tum → burst memory 6× trên endpoint
    // `/thumbnails/:getPixels` (limit ~10GB/user, error 400 "User memory limit
    // exceeded"). Dùng bản native cho download vẫn giữ RF quality vì
    // getDownloadURL sẽ pin lại theo scale param của nó.
    const classifiedNative = classified;
    if (cfg.PIN_DISPLAY_SCALE && classified) {
        classified = classified.reproject({ crs: 'EPSG:4326', scale: cfg.DISPLAY_SCALE_M });
    }

    return {
        classified,
        classifiedNative,
        oobPct,
        testAccuracyPct,
        testKappa,
        hasGroundTruth: hasGT,
        // Backwards-compatible quotas shape. v4.1 dùng quota per-class từ
        // sqrt(area); giá trị dưới là aggregate (input=GT quotas, threshold=thr
        // quotas, dataset=0 vì v4.1 bỏ DW).
        quotas: {
            inputQuota:     hasGT ? quotasPerClass.reduce((a, b) => a + b, 0) : 0,
            datasetQuota:   0,
            thresholdQuota: thrQuota.reduce((a, b) => a + b, 0),
            inputTestQuota: hasGT ? Math.max(minFieldTest, Math.round(quotasPerClass.reduce((a, b) => a + b, 0) * 0.4 / cfg.CLASS_NAMES.length)) : 0,
            perClass:       quotasPerClass,
        },
        featureImage: image,
        base,
        trainSet,
        inputTestSamples,
        // NEW v4.1 diagnostics
        modelMeta: {
            pipelineVersion:  'v5.3-2026-07-24',
            month,
            windows:          F.windows,
            sampleBudget,
            rfTrees,
            hasNaturalCoreExclusion: true,
            residualClass0:   false,
            worldCoverEpoch:  wc ? (year === 2020 ? 'v100' : 'v200') : null,
            dynamicWorldUsed: Boolean(dwBuilt),
            otherLandAssetUsed: Boolean(otherLandAssetId),
            minScore: cfg.MIN_SCORE,
            rfSkipReason:     rfSkipReason || null,
            sampleHist:       sampleHist || null,
            semantics: {
                riskLevel: null,
                forestClassIds:         cfg.FOREST_CLASS_IDS,
                treeDominatedClassIds:  cfg.TREE_DOMINATED_CLASS_IDS,
                note: 'Diện tích rừng theo schema = classes 4-9. Class 2 (Cây công nghiệp) không tính là rừng dù cao su có ~40.000 ha được kiểm kê là rừng trồng.',
            },
        },
    };
}

module.exports = {
    // v4.1 public API
    buildFeatureImage,
    buildThresholds,
    buildLabel,
    buildRelaxedLabel,
    permanentWater,
    dynamicWorldBuiltFraction,
    otherLandMask,
    worldCoverForYear,
    computeQuotas,
    sampleLabel,
    sampleGT,
    addSpatialBlock,
    runRfClassification,
    // v3 legacy shims (kept for backwards-compat imports)
    buildPriorityLabel,
    buildThresholdLabel,
    buildDatasetLabel,
    sampleFromLabel,
    sampleGroundTruth,
    buildExclusionMask,
};
