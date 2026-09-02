'use strict';

/**
 * Recovery chạy đúng một lần sau khi runtime lấy được PostgreSQL advisory lock.
 *
 * Vì process cũ đã mất lock/DB connection, mọi snapshot pending/computing còn
 * trong DB chắc chắn là orphan. Đóng chúng ngay và tạo attempt mới qua queue
 * GEE chung, thay vì đợi watchdog 45 phút–2 giờ.
 */

const fireRepo = require('../repositories/fire-risk.repository');
const forestRepo = require('../repositories/forest-classification.repository');
const fireService = require('../services/fire-risk.service');
const forestService = require('../services/forest-classification.service');

const recoverInterruptedRuns = async () => {
    const [
        fireRows,
        forestRows,
        fireDistrictSnapshotIds,
        forestDistrictSnapshotIds,
    ] = await Promise.all([
        fireRepo.failInterruptedActiveRuns(),
        forestRepo.failInterruptedActiveRuns(),
        fireRepo.failInterruptedDistrictExports(),
        forestRepo.failInterruptedDistrictExports(),
    ]);

    if (
        fireRows.length === 0
        && forestRows.length === 0
        && fireDistrictSnapshotIds.length === 0
        && forestDistrictSnapshotIds.length === 0
    ) {
        console.info('[GEE-RECOVERY] Không có snapshot bị gián đoạn.');
        return { fire: 0, forest: 0 };
    }

    const fireByDate = new Map();
    for (const row of fireRows) {
        const date = fireService.formatDateVN(row.analysis_date);
        if (date) fireByDate.set(date, row);
    }
    for (const snapshotId of fireDistrictSnapshotIds) {
        const row = await fireRepo.getById(snapshotId);
        const date = fireService.formatDateVN(row?.analysis_date);
        if (date) fireByDate.set(date, row);
    }
    const forestByPeriod = new Map();
    for (const row of forestRows) {
        forestByPeriod.set(`${row.year}-${row.month}`, row);
    }
    for (const snapshotId of forestDistrictSnapshotIds) {
        const row = await forestRepo.getById(snapshotId);
        if (row) forestByPeriod.set(`${row.year}-${row.month}`, row);
    }

    console.warn(
        `[GEE-RECOVERY] Đã đóng orphan snapshots: fire=${fireRows.length}, `
        + `forest=${forestRows.length}; orphan district exports: `
        + `fireSnapshots=${fireDistrictSnapshotIds.length}, `
        + `forestSnapshots=${forestDistrictSnapshotIds.length}. `
        + `Queue retry unique fire=${fireByDate.size}, `
        + `forest=${forestByPeriod.size}.`,
    );

    const fireRetries = [...fireByDate.entries()]
        .sort(([dateA], [dateB]) => dateB.localeCompare(dateA));
    for (const [analysisDate, row] of fireRetries) {
        const modelParams = row.model_params || {};
        fireService.runAnalysis(analysisDate, {
            ...(modelParams.rf_enabled !== undefined
                ? { enableRf: Boolean(modelParams.rf_enabled) }
                : {}),
            ...(modelParams.rf_compute_oob !== undefined
                ? { computeOob: Boolean(modelParams.rf_compute_oob) }
                : {}),
            ...(modelParams.input_fire_asset_id
                ? { inputFireAssetId: modelParams.input_fire_asset_id }
                : {}),
        }).catch((error) => {
            console.error(
                `[GEE-RECOVERY] fire retry date=${analysisDate} failed: ${error.message}`,
            );
        });
    }

    const forestRetries = [...forestByPeriod.values()]
        .sort((a, b) => (b.year - a.year) || (b.month - a.month));
    for (const row of forestRetries) {
        forestService.runAnalysis(row.year, row.month, {
            trigger: 'recovery',
        }).catch((error) => {
            console.error(
                `[GEE-RECOVERY] forest retry period=${row.year}/${row.month} `
                + `failed: ${error.message}`,
            );
        });
    }

    return {
        fire: fireByDate.size,
        forest: forestByPeriod.size,
    };
};

module.exports = {
    recoverInterruptedRuns,
};
