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
const { Api400Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const round = (n, d = 2) => (n == null ? null : Number(Number(n).toFixed(d)));
const DASHBOARD_TTL = Number(process.env.STATS_DASHBOARD_TTL_SECONDS) || 600; // 10 phút

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

// ══════════════════════════════════════════════════════════════════════════════
//  US-063 — Dashboard điều hành (cache TTL)
// ══════════════════════════════════════════════════════════════════════════════
const getDashboard = async ({ lang, force = false } = {}) => {
    const cacheKey = 'dashboard:executive';
    if (!force) {
        const cached = await repo.getCache(cacheKey);
        if (cached) {
            return { ...cached.payload, cached: true, computedAt: cached.computed_at };
        }
    }

    const years = await repo.getAvailableYears();
    const latestYear = years[0] || null;

    const [districts, provinceSummary, feedbackRows] = await Promise.all([
        latestYear ? repo.getLandcoverByDistrict({ year: latestYear, forestType: 'total' }) : Promise.resolve([]),
        latestYear ? repo.getProvinceSummary(latestYear) : Promise.resolve([]),
        repo.getFeedbackCounts(),
    ]);

    // Top 5 huyện che phủ cao nhất
    const topCoverage = districts
        .map((d) => ({ unitCode: d.unit_code, name: d.name_vi, coveragePct: round(d.coverage_pct), forestAreaHa: round(d.area_ha) }))
        .sort((a, b) => (b.coveragePct || 0) - (a.coveragePct || 0))
        .slice(0, 5);

    // Top 5 huyện che phủ thấp nhất (nguy cơ / cần chú ý)
    const lowCoverage = districts
        .map((d) => ({ unitCode: d.unit_code, name: d.name_vi, coveragePct: round(d.coverage_pct) }))
        .sort((a, b) => (a.coveragePct || 0) - (b.coveragePct || 0))
        .slice(0, 5);

    const provByType = {};
    provinceSummary.forEach((p) => { provByType[p.forest_type] = round(p.area_ha); });

    const feedbackByStatus = {};
    feedbackRows.forEach((f) => { feedbackByStatus[f.status] = f.count; });
    const feedbackTotal = feedbackRows.reduce((s, f) => s + f.count, 0);

    const provinceCoverage = provinceSummary.find((p) => p.forest_type === 'total');

    const payload = {
        year: latestYear,
        forest: {
            provinceCoveragePct: provinceCoverage ? round(provinceCoverage.coverage_pct) : null,
            totalForestHa:       provByType.total ?? null,
            naturalForestHa:     provByType.natural ?? null,
            plantedForestHa:     provByType.planted ?? null,
            topCoverageDistricts: topCoverage,
            lowCoverageDistricts: lowCoverage,
        },
        feedback: {
            total:    feedbackTotal,
            byStatus: feedbackByStatus,
        },
        // Cảnh báo cháy: EP-06 chưa hiện thực — để placeholder cho FE.
        fireAlerts: { available: false, note: 'EP-06 (fire risk) chưa triển khai' },
    };

    await repo.setCache(cacheKey, payload, DASHBOARD_TTL);
    return { ...payload, cached: false, computedAt: new Date().toISOString() };
};

module.exports = {
    getLandcover,
    getAdministrativeUnits,
    getDashboard,
};
