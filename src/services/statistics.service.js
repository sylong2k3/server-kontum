'use strict';

/**
 * Statistics Service (EP-07).
 *
 * US-060: Diện tích lớp phủ / che phủ rừng theo huyện + mốc thời gian.
 * US-063: Dashboard điều hành (tổng hợp + cache TTL).
 *
 * Nguồn dữ liệu (sau migration 041 — gis.landcover_statistics đã DROP):
 *   • forest.forest_snapshots        — kết quả pipeline phân loại 13-class v5.3
 *   • forest.forest_district_areas   — diện tích per huyện per class per snapshot
 *   • gis.administrative_units       — 10 huyện + tỉnh (mã, diện tích km², dân số)
 *   • fire.fire_risk_snapshots       — dashboard block cháy rừng
 *   • field.feedback                 — dashboard block phản ánh
 */

const repo = require('../repositories/statistics.repository');
const fireRiskRepo = require('../repositories/fire-risk.repository');
const forestClassificationRepo = require('../repositories/forest-classification.repository');
const forestClassificationConfig = require('../configs/forest-classification');
const { Api400Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const round = (n, d = 2) => (n == null ? null : Number(Number(n).toFixed(d)));
const DASHBOARD_TTL = Number(process.env.STATS_DASHBOARD_TTL_SECONDS) || 600; // 10 phút

// ── Fire-risk dashboard block ─────────────────────────────────────────────────
// Trích min/max/avg + hotspot count từ snapshot mới nhất trong `fire.fire_risk_snapshots`.
const _buildFireRiskDashboard = async () => {
    try {
        const { items } = await fireRiskRepo.listCompleted({ page: 1, limit: 1 });
        const snap = items?.[0];
        if (!snap) {
            return { available: false, note: 'Chưa có snapshot fire-risk.' };
        }
        const summary = snap.province_summary || {};
        const dist    = summary.riskLevelDist || {};

        // Min level = cấp thấp nhất >= 1 có ha > 0 (bỏ cấp 0 = thiếu ảnh)
        let minLevel = null, maxLevel = null;
        for (let l = 1; l <= 5; l++) {
            if ((Number(dist[l]) || 0) > 0) {
                if (minLevel == null) minLevel = l;
                maxLevel = l;
            }
        }

        // Hotspot districts = huyện có riskLevel ≥ 3 với ha > 0 (đồng nghĩa
        // với định nghĩa client-side `HOTSPOT_MIN_LEVEL = 3`).
        const HOTSPOT_MIN = 3;
        const districtStats = Array.isArray(snap.district_stats) ? snap.district_stats : [];
        let hotspotCount = 0;
        for (const d of districtStats) {
            const dDist = d.riskLevelDist || {};
            for (let l = HOTSPOT_MIN; l <= 5; l++) {
                if ((Number(dDist[l]) || 0) > 0) { hotspotCount++; break; }
            }
        }

        return {
            available:    true,
            snapshotId:   snap.id,
            analysisDate: snap.analysis_date,
            avgLevel:     round(summary.avgRiskLevel),
            minLevel,
            maxLevel,
            riskLevelDist: dist,
            s2CoverageRatio: round(summary.s2CoverageRatio),
            hotspotDistrictCount: hotspotCount,
            hotspotMinLevel:      HOTSPOT_MIN,
            geoserverLayer:       snap.geoserver_layer || null,
            geeDownloadUrl:       snap.gee_download_url || null,
            publishedAt:          snap.published_at || null,
        };
    } catch (err) {
        console.warn('[STATS] fire-risk dashboard build failed:', err.message);
        return { available: false, note: err.message };
    }
};

// ── Forest-classification dashboard block ────────────────────────────────────
// Dùng snapshot theo tháng mới nhất thay vì số liệu seed theo năm. Khối này
// phản ánh đúng pipeline phân loại 11 lớp đang vận hành và trạng thái publish.
const _buildForestClassificationDashboard = async () => {
    try {
        const snap = await forestClassificationRepo.getLatestCompleted();
        if (!snap) {
            return { available: false, note: 'Chưa có snapshot phân loại rừng.' };
        }

        const summary = snap.province_summary || {};
        const byClass = summary.byClass || {};
        const totalAreaHa = Number(summary.totalHa)
            || Object.values(byClass).reduce((sum, value) => sum + (Number(value) || 0), 0);
        const forestAreaHa = forestClassificationConfig.FOREST_CLASS_IDS.reduce(
            (sum, classId) => sum + (Number(byClass[classId]) || 0),
            0,
        );
        const dominantEntry = Object.entries(byClass).reduce(
            (best, entry) => (Number(entry[1]) > Number(best?.[1] || 0) ? entry : best),
            null,
        );
        const dominantClassId = dominantEntry ? Number(dominantEntry[0]) : null;

        const previous = await forestClassificationRepo.getPreviousCompleted(snap.year, snap.month);
        const previousByClass = previous?.province_summary?.byClass || {};
        const previousForestHa = previous
            ? forestClassificationConfig.FOREST_CLASS_IDS.reduce(
                (sum, classId) => sum + (Number(previousByClass[classId]) || 0),
                0,
            )
            : null;
        const forestDeltaHa = previousForestHa == null ? null : forestAreaHa - previousForestHa;

        return {
            available:        true,
            snapshotId:       snap.id,
            year:             snap.year,
            month:            snap.month,
            status:           snap.status,
            totalAreaHa:      round(totalAreaHa),
            forestAreaHa:     round(forestAreaHa),
            forestCoveragePct: totalAreaHa > 0 ? round((forestAreaHa / totalAreaHa) * 100) : null,
            byClass,
            dominantClassId,
            dominantClassName: dominantClassId == null
                ? null
                : forestClassificationConfig.CLASS_NAMES[dominantClassId] || null,
            dominantClassAreaHa: dominantEntry ? round(Number(dominantEntry[1])) : null,
            oobAccuracy:       round(snap.oob_accuracy),
            testAccuracy:      round(snap.test_accuracy),
            testKappa:         round(snap.test_kappa, 3),
            s2ImageCount:      snap.s2_image_count ?? null,
            landsatImageCount: snap.ls_image_count ?? null,
            geoserverLayer:    snap.geoserver_layer || null,
            geeDownloadUrl:    snap.gee_download_url || null,
            computedAt:        snap.computed_at || null,
            publishedAt:       snap.published_at || null,
            comparison: previous ? {
                previousSnapshotId: previous.id,
                previousYear:       previous.year,
                previousMonth:      previous.month,
                forestDeltaHa:      round(forestDeltaHa),
                forestChangePct:    previousForestHa > 0
                    ? round((forestDeltaHa / previousForestHa) * 100)
                    : null,
            } : null,
        };
    } catch (err) {
        console.warn('[STATS] forest-classification dashboard build failed:', err.message);
        return { available: false, note: err.message };
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  US-060 — Diện tích lớp phủ theo huyện (source: forest.forest_snapshots)
//
//  Migration 041: bảng gis.landcover_statistics đã bị DROP. Endpoint này giờ
//  aggregate từ snapshot phân loại rừng 13-class v5.3 — nguồn nghiệp vụ duy
//  nhất.
//
//  Cách chọn dữ liệu cho một năm Y:
//     • Lấy snapshot completed/published mới nhất có forest_snapshots.year = Y.
//     • Từ forest_district_areas → aggregate per district theo mapping:
//         forest_type = 'total'      → sum FOREST_CLASS_IDS (4..9)
//         forest_type = 'natural'    → sum classes [4,5,6,7,8]
//         forest_type = 'planted'    → class 9
//         forest_type = 'non_forest' → sum các class khác (0,1,2,3,10,11,12)
//     • coveragePct = forestArea / (admin_units.area_km2 * 100) — dùng ranh
//       giới hành chính chuẩn, KHÔNG dùng tổng pixel classify (dễ lệch khi
//       class=0 no-data lớn).
// ══════════════════════════════════════════════════════════════════════════════

const _NATURAL_CLASS_IDS_LC = [4, 5, 6, 7, 8];
const _PLANTED_CLASS_IDS_LC = [9];

function _sumByClass(byClass, classIds) {
    let s = 0;
    for (const id of classIds) s += Number(byClass?.[id]) || 0;
    return s;
}

function _pickForestArea(byClass, forestType, config) {
    switch (forestType) {
        case 'natural':    return _sumByClass(byClass, _NATURAL_CLASS_IDS_LC);
        case 'planted':    return _sumByClass(byClass, _PLANTED_CLASS_IDS_LC);
        case 'non_forest': {
            const total = Object.values(byClass || {}).reduce((s, v) => s + (Number(v) || 0), 0);
            const forest = _sumByClass(byClass, config.FOREST_CLASS_IDS);
            return Math.max(0, total - forest);
        }
        case 'total':
        default:           return _sumByClass(byClass, config.FOREST_CLASS_IDS);
    }
}

const getLandcover = async ({ year, forestType = 'total', lang }) => {
    const years = await forestClassificationRepo.getSnapshotYears();
    if (years.length === 0) {
        return { year: null, forestType, items: [], summary: null, no_data: true, availableYears: [] };
    }

    const targetYear = year || years[0]; // mặc định năm mới nhất
    if (year && !years.includes(year)) {
        throw new Api400Error(
            t('stats_year_not_available', lang, { years: years.join(', ') }),
            ['YEAR_NOT_AVAILABLE'],
        );
    }

    // Lấy snapshot completed mới nhất cho năm đích.
    const snap = await forestClassificationRepo.getLatestCompletedByYear(targetYear);
    if (!snap) {
        return {
            year:           targetYear,
            forestType,
            availableYears: years,
            items:          [],
            summary:        null,
            no_data:        true,
            source:         'forest_snapshot',
        };
    }

    // Lấy danh sách huyện chuẩn từ administrative_units — join thủ công phía JS
    // để đảm bảo mọi huyện đều xuất hiện (kể cả huyện không có pixel trong snapshot).
    const [districts, districtAreas] = await Promise.all([
        repo.listAdministrativeUnits('district'),
        forestClassificationRepo.getDistrictAreas(snap.id),
    ]);

    // Map: districtCode → { classId: ha }
    const byDistrict = new Map();
    for (const d of districtAreas) {
        const key = d.districtCode || d.districtName;
        if (!key) continue;
        if (!byDistrict.has(key)) byDistrict.set(key, {});
        const bag = byDistrict.get(key);
        for (const c of d.classes) {
            bag[c.classId] = (bag[c.classId] || 0) + Number(c.areaHa || 0);
        }
    }

    const items = districts.map((u) => {
        const byClass  = byDistrict.get(u.code) || {};
        const forestHa = _pickForestArea(byClass, forestType, forestClassificationConfig);
        const areaHa   = Number(u.area_km2) * 100;   // km² → ha
        const coverage = areaHa > 0 ? (forestHa / areaHa) * 100 : null;
        return {
            unitCode:     u.code,
            name:         u.name_vi,
            nameEn:       u.name_en,
            areaKm2:      round(u.area_km2),
            population:   u.population,
            forestAreaHa: round(forestHa),
            coveragePct:  coverage != null ? round(coverage) : null,
            changePct:    null,   // TODO: so với snapshot cùng tháng năm trước
        };
    });

    const totalForestHa = items.reduce((s, i) => s + (i.forestAreaHa || 0), 0);

    return {
        year:           targetYear,
        forestType,
        availableYears: years,
        source:         'forest_snapshot',
        snapshotId:     snap.id,
        snapshotPeriod: `${snap.year}-${String(snap.month).padStart(2, '0')}`,
        items,
        summary: {
            districtCount:  items.length,
            totalForestHa:  round(totalForestHa),
            avgCoveragePct: items.length
                ? round(items.reduce((s, i) => s + (i.coveragePct || 0), 0) / items.length)
                : null,
        },
        no_data: items.length === 0,
    };
};

// ══════════════════════════════════════════════════════════════════════════════
//  Danh sách đơn vị hành chính (hỗ trợ FE dropdown / bản đồ)
// ══════════════════════════════════════════════════════════════════════════════
const getAdministrativeUnits = async ({ level = 'district' } = {}) => {
    const rows = await repo.listAdministrativeUnits(level);
    return rows.map((r) => ({
        code:       r.code,
        name:       r.name_vi,
        nameEn:     r.name_en,
        level:      r.level,
        parentCode: r.parent_code,
        areaKm2:    round(r.area_km2),
        population: r.population,
        centroid:   (r.centroid_lng != null && r.centroid_lat != null)
            ? { lng: r.centroid_lng, lat: r.centroid_lat } : null,
    }));
};

// Vai trò nào xem dashboard "vận hành" (chi tiết theo huyện + việc cần xử lý)
// thay vì "điều hành" (tổng quan cấp tỉnh, dùng để báo cáo/ra quyết định).
const OPERATIONAL_ROLES = ['so_nnmt'];
const scopeForRole = (role) => (OPERATIONAL_ROLES.includes(role) ? 'operational' : 'executive');

// ══════════════════════════════════════════════════════════════════════════════
//  US-063 — Dashboard điều hành (cache TTL), nội dung khác nhau theo vai trò:
//  - executive (system_admin, ubnd_tinh): tổng quan toàn tỉnh — top/low 5 huyện,
//    tổng phản ánh theo trạng thái. Dùng để báo cáo/ra quyết định.
//  - operational (so_nnmt): chi tiết toàn bộ huyện (không rút gọn top/low) +
//    danh sách phản ánh đang chờ xử lý (new/in_progress, ưu tiên cao trước).
//    Dùng để điều phối xử lý hiện trường.
// ══════════════════════════════════════════════════════════════════════════════
// Class ID cho rừng tự nhiên (schema v5.3 13-class):
//   4 Rừng hỗn giao, 5 Rừng lá rộng thường xanh, 6 Rừng lá kim,
//   7 Rừng lá rộng rụng lá, 8 Rừng tre nứa
// Rừng trồng = class 9.
// Tổng cây thân gỗ (natural + planted) = FOREST_CLASS_IDS (config đã có).
const _NATURAL_FOREST_CLASS_IDS = [4, 5, 6, 7, 8];
const _PLANTED_FOREST_CLASS_IDS = [9];

/**
 * Build 4 số nổi bật cho dashboard (Tổng, Tự nhiên, Trồng, Che phủ) từ
 * snapshot forest-classification mới nhất — thay cho gis.landcover_statistics
 * seed cứng (migration 041 đã dọn dữ liệu cũ).
 */
async function _buildForestSummaryFromSnapshot(snap, config) {
    if (!snap?.province_summary) {
        return {
            source:               'no_snapshot',
            totalForestHa:        null,
            naturalForestHa:      null,
            plantedForestHa:      null,
            provinceCoveragePct:  null,
        };
    }

    const byClass    = snap.province_summary.byClass || {};
    const totalHa    = Number(snap.province_summary.totalHa) || 0;
    const naturalHa  = _NATURAL_FOREST_CLASS_IDS.reduce(
        (sum, id) => sum + (Number(byClass[id]) || 0), 0,
    );
    const plantedHa  = _PLANTED_FOREST_CLASS_IDS.reduce(
        (sum, id) => sum + (Number(byClass[id]) || 0), 0,
    );
    const forestHa   = config.FOREST_CLASS_IDS.reduce(
        (sum, id) => sum + (Number(byClass[id]) || 0), 0,
    );

    // Base để tính % che phủ: dùng PROVINCE_TOTAL_HA (967.417 ha) nếu totalHa
    // classify < 90% (khả năng có class 0 no-data lớn). Nếu classify đủ
    // (>= 90% diện tích tỉnh), lấy chính totalHa cho ổn định giữa các tháng.
    const provinceTotal = config.PROVINCE_TOTAL_HA || 967417;
    const coverageBase  = totalHa >= provinceTotal * 0.90 ? totalHa : provinceTotal;
    const coveragePct   = coverageBase > 0
        ? Math.round((forestHa / coverageBase) * 10000) / 100
        : null;

    return {
        source:              'forest_snapshot',
        snapshotId:          snap.id,
        year:                snap.year,
        month:               snap.month,
        computedAt:          snap.computed_at,
        totalForestHa:       round(forestHa),
        naturalForestHa:     round(naturalHa),
        plantedForestHa:     round(plantedHa),
        provinceCoveragePct: coveragePct,
    };
}

/**
 * Top / low coverage districts từ forest_district_areas của snapshot mới nhất.
 * Coverage % huyện = (Σ forest classes ha) / (Σ all classes ha) × 100.
 */
async function _buildDistrictCoverageFromSnapshot(snap, config) {
    if (!snap) return [];
    const rows = await forestClassificationRepo.getDistrictAreas(snap.id);
    const items = rows.map((d) => {
        const byId = {};
        let total = 0, forest = 0;
        for (const c of d.classes) {
            byId[c.classId] = c.areaHa;
            total += Number(c.areaHa) || 0;
            if (config.FOREST_CLASS_IDS.includes(c.classId)) {
                forest += Number(c.areaHa) || 0;
            }
        }
        return {
            unitCode:     d.districtCode,
            name:         d.districtName,
            coveragePct:  total > 0 ? round((forest / total) * 100) : null,
            forestAreaHa: round(forest),
            changePct:    null,   // TODO: so sánh với snapshot trước nếu cần
        };
    });
    return items.sort((a, b) => (a.coveragePct || 0) - (b.coveragePct || 0));
}

const getDashboard = async ({ lang, force = false, role } = {}) => {
    const scope = scopeForRole(role);
    // Bump cache key sang v3 khi migration 041 đổi nguồn dữ liệu (từ
    // gis.landcover_statistics → forest.forest_snapshots) — invalidate
    // hoàn toàn payload v2 cũ để user không thấy số seed cứng cache lại.
    const cacheKey = `dashboard:v3:${scope}`;
    if (!force) {
        const cached = await repo.getCache(cacheKey);
        if (cached) {
            return { ...cached.payload, cached: true, computedAt: cached.computed_at };
        }
    }

    // 4 số nổi bật + district items giờ derive từ forest_snapshots thay vì
    // gis.landcover_statistics (migration 041). Snapshot mới nhất completed
    // = "current state" cho toàn dashboard.
    const forestSnap = await forestClassificationRepo.getLatestCompleted();

    const [feedbackRows, pendingFeedback, forestSummary, districtItems] = await Promise.all([
        repo.getFeedbackCounts(),
        scope === 'operational' ? repo.getPendingFeedback(10) : Promise.resolve([]),
        _buildForestSummaryFromSnapshot(forestSnap, forestClassificationConfig),
        _buildDistrictCoverageFromSnapshot(forestSnap, forestClassificationConfig),
    ]);

    const feedbackByStatus = {};
    feedbackRows.forEach((f) => { feedbackByStatus[f.status] = f.count; });
    const feedbackTotal = feedbackRows.reduce((s, f) => s + f.count, 0);

    const forest = {
        source:              forestSummary.source,        // 'forest_snapshot' | 'no_snapshot'
        snapshotId:          forestSummary.snapshotId ?? null,
        snapshotPeriod:      forestSnap
            ? `${forestSnap.year}-${String(forestSnap.month).padStart(2, '0')}`
            : null,
        provinceCoveragePct: forestSummary.provinceCoveragePct,
        totalForestHa:       forestSummary.totalForestHa,
        naturalForestHa:     forestSummary.naturalForestHa,
        plantedForestHa:     forestSummary.plantedForestHa,
    };

    if (scope === 'operational') {
        forest.districts = districtItems; // toàn bộ huyện, sắp theo che phủ tăng dần (huyện nguy cơ trước)
    } else {
        forest.topCoverageDistricts = [...districtItems].reverse().slice(0, 5);
        forest.lowCoverageDistricts = districtItems.slice(0, 5);
    }

    const feedback = { total: feedbackTotal, byStatus: feedbackByStatus };
    if (scope === 'operational') {
        feedback.pending = pendingFeedback.map((f) => ({
            id:        f.id,
            category:  f.category,
            title:     f.title,
            status:    f.status,
            priority:  f.priority,
            lng:       f.lng,
            lat:       f.lat,
            createdAt: f.created_at,
        }));
    }

    // ── Fire risk: min/max/mean cấp cảnh báo từ snapshot completed mới nhất ─
    // Không có trường "điểm số"; dùng riskLevel 1-5 làm proxy. Trả:
    //   - avgLevel: `avg_risk_level` (weighted theo pixel)
    //   - maxLevel: cấp cao nhất có ha > 0
    //   - minLevel: cấp thấp nhất có ha > 0 (bỏ qua Cấp 0 = thiếu ảnh)
    //   - riskLevelDist: breakdown ha theo cấp (0-5)
    //   - hotspotDistrictCount: số huyện có maxLevel ≥ 3 (định nghĩa "điểm nóng")
    //   - snapshotId + analysisDate + link để admin bấm publish
    const [fireAlerts, forestClassification] = await Promise.all([
        _buildFireRiskDashboard(),
        _buildForestClassificationDashboard(),
    ]);

    const payload = {
        scope,
        // `year` giờ = năm của snapshot forest classify mới nhất (không phải
        // "năm dữ liệu Bộ NN&PTNT" như trước). Client vẫn hiển thị "dữ liệu
        // năm X" tự nhiên.
        year: forestSnap?.year ?? null,
        forest,
        feedback,
        fireAlerts,
        forestClassification,
    };

    await repo.setCache(cacheKey, payload, DASHBOARD_TTL);
    return { ...payload, cached: false, computedAt: new Date().toISOString() };
};

module.exports = {
    getLandcover,
    getAdministrativeUnits,
    getDashboard,
};
