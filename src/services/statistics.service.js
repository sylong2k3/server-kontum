'use strict';

/**
 * Statistics Service (EP-07).
 *
 * US-060: Diện tích lớp phủ / che phủ rừng theo huyện + mốc thời gian.
 * US-063: Dashboard điều hành (tổng hợp + cache TTL).
 *
 * Nguồn dữ liệu: gis.landcover_statistics (seed số liệu thực Kon Tum) +
 * gis.administrative_units. Khi có lớp GIS rừng được import, có thể thay thế
 * bằng aggregate ST_Area(geom) trực tiếp (xem getLandcoverFromLayer — TODO).
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
//  US-060 — Diện tích lớp phủ theo huyện
// ══════════════════════════════════════════════════════════════════════════════
const getLandcover = async ({ year, forestType = 'total', lang }) => {
    const years = await repo.getAvailableYears();
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

    const rows = await repo.getLandcoverByDistrict({ year: targetYear, forestType });

    const items = rows.map((r) => ({
        unitCode:    r.unit_code,
        name:        r.name_vi,
        nameEn:      r.name_en,
        areaKm2:     round(r.area_km2),
        population:  r.population,
        forestAreaHa: round(r.area_ha),
        coveragePct: round(r.coverage_pct),
        changePct:   round(r.change_pct),     // so với năm liền trước (null nếu không có)
    }));

    const totalForestHa = items.reduce((s, i) => s + (i.forestAreaHa || 0), 0);

    return {
        year:         targetYear,
        forestType,
        availableYears: years,
        items,
        summary: {
            districtCount:  items.length,
            totalForestHa:  round(totalForestHa),
            // Che phủ trung bình theo diện tích huyện (weighted) tham khảo.
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
const getDashboard = async ({ lang, force = false, role } = {}) => {
    const scope = scopeForRole(role);
    const cacheKey = `dashboard:v2:${scope}`;
    if (!force) {
        const cached = await repo.getCache(cacheKey);
        if (cached) {
            return { ...cached.payload, cached: true, computedAt: cached.computed_at };
        }
    }

    const years = await repo.getAvailableYears();
    const latestYear = years[0] || null;

    const [districts, provinceSummary, feedbackRows, pendingFeedback] = await Promise.all([
        latestYear ? repo.getLandcoverByDistrict({ year: latestYear, forestType: 'total' }) : Promise.resolve([]),
        latestYear ? repo.getProvinceSummary(latestYear) : Promise.resolve([]),
        repo.getFeedbackCounts(),
        scope === 'operational' ? repo.getPendingFeedback(10) : Promise.resolve([]),
    ]);

    const districtItems = districts
        .map((d) => ({
            unitCode:     d.unit_code,
            name:         d.name_vi,
            coveragePct:  round(d.coverage_pct),
            forestAreaHa: round(d.area_ha),
            changePct:    round(d.change_pct),
        }))
        .sort((a, b) => (a.coveragePct || 0) - (b.coveragePct || 0));

    const provByType = {};
    provinceSummary.forEach((p) => { provByType[p.forest_type] = round(p.area_ha); });

    const feedbackByStatus = {};
    feedbackRows.forEach((f) => { feedbackByStatus[f.status] = f.count; });
    const feedbackTotal = feedbackRows.reduce((s, f) => s + f.count, 0);

    const provinceCoverage = provinceSummary.find((p) => p.forest_type === 'total');

    const forest = {
        provinceCoveragePct: provinceCoverage ? round(provinceCoverage.coverage_pct) : null,
        totalForestHa:       provByType.total ?? null,
        naturalForestHa:     provByType.natural ?? null,
        plantedForestHa:     provByType.planted ?? null,
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
        year: latestYear,
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
