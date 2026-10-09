'use strict';

// Mock DB, GEE config, repositories, queues and migration helpers
jest.mock('../../configs/database', () => ({
    query: jest.fn(),
    getClient: jest.fn(),
}));
jest.mock('../../../kt_gee_migration/configs/database', () => ({
    query: jest.fn(),
    getClient: jest.fn(),
}), { virtual: true });
jest.mock('../../configs/gge', () => ({
    ee: {},
    initializeEarthEngine: jest.fn(),
}), { virtual: true });
jest.mock('../../../kt_gee_migration/configs/gge', () => ({
    ee: {},
    initializeEarthEngine: jest.fn(),
}), { virtual: true });
jest.mock('../../repositories/fire-risk.repository', () => ({}), { virtual: true });
jest.mock('../../../kt_gee_migration/repositories/fire-risk.repository', () => ({}), { virtual: true });
jest.mock('../../queues/gee-task.queue', () => ({}), { virtual: true });
jest.mock('../../../kt_gee_migration/queues/gee-task.queue', () => ({}), { virtual: true });
jest.mock('../../workers/districtRasterExport.worker', () => ({}), { virtual: true });
jest.mock('../../../kt_gee_migration/workers/districtRasterExport.worker', () => ({}), { virtual: true });
jest.mock('../../workers/geeAnalysisProcess.worker', () => ({}), { virtual: true });
jest.mock('../../../kt_gee_migration/workers/geeAnalysisProcess.worker', () => ({}), { virtual: true });
jest.mock('../../../kt_gee_migration/utils/gee-export.helper', () => ({}), { virtual: true });
jest.mock('../../../kt_gee_migration/utils/stage-logger.util', () => ({
    makeStageLogger: () => () => {},
}), { virtual: true });
jest.mock('../../../kt_gee_migration/core/error.response', () => ({
    BusinessLogicError: class extends Error {},
}), { virtual: true });
jest.mock('../../../kt_gee_migration/core/http-status-code', () => ({
    StatusCodes: {},
}), { virtual: true });

const { buildFireRiskCompletedNotification: buildPayloadSrc } = require('../fire-risk.service');
const { buildFireRiskCompletedNotification: buildPayloadMig } = require('../../../kt_gee_migration/services/fire-risk.service');

describe('W078 — Fire Risk Completed Notification Payload Builder', () => {
    const testSuites = [
        { name: 'Active service (server/src/services/fire-risk.service.js)', builder: buildPayloadSrc },
        { name: 'Migration service (server/kt_gee_migration/services/fire-risk.service.js)', builder: buildPayloadMig },
    ];

    testSuites.forEach(({ name, builder }) => {
        describe(name, () => {
            test('normal completion (maxLvl < 4) produces canonical update title without legacy "hoàn thành"', () => {
                const snapshot = { id: 101, analysis_date: '2026-03-01T00:00:00.000Z' };
                const provinceSummary = {
                    riskLevelDist: { 1: 100, 2: 250, 3: 50 },
                    avgRiskLevel: 2.15,
                };

                const payload = builder(snapshot, provinceSummary);

                expect(payload.type).toBe('fire_risk_completed');
                expect(payload.channel).toBe('system');
                expect(payload.title).toBe('Đã cập nhật dữ liệu nguy cơ cháy rừng ngày 2026-03-01');
                expect(payload.title).not.toContain('hoàn thành');
                expect(payload.title).not.toContain('Cảnh báo cháy rừng 2026-03-01 hoàn thành');
                expect(payload.body).toContain('Cấp: 1–3 (TB 2.15)');
                expect(payload.data.minLevel).toBe(1);
                expect(payload.data.maxLevel).toBe(3);
                expect(payload.data.avgLevel).toBe(2.15);
                expect(payload.data.snapshotId).toBe(101);
                expect(payload.data.analysisDate).toBe('2026-03-01');
            });

            test('high-risk branch (maxLvl >= 4) produces alert title with warning symbol', () => {
                const snapshot = { id: 102, analysis_date: '2026-04-15T00:00:00.000Z' };
                const provinceSummary = {
                    riskLevelDist: { 1: 10, 2: 20, 3: 40, 4: 80, 5: 15 },
                    avgRiskLevel: 3.85,
                };

                const payload = builder(snapshot, provinceSummary);

                expect(payload.type).toBe('fire_risk_high');
                expect(payload.channel).toBe('alert');
                expect(payload.title).toBe('⚠ Cảnh báo cháy rừng cao ngày 2026-04-15');
                expect(payload.title).not.toContain('hoàn thành');
                expect(payload.body).toContain('Cấp: 1–5 (TB 3.85)');
                expect(payload.data.minLevel).toBe(1);
                expect(payload.data.maxLevel).toBe(5);
            });

            test('missing min/max and empty distribution handles fallback honestly', () => {
                const snapshot = { id: 103, analysis_date: '2026-05-20T00:00:00.000Z' };
                const provinceSummary = {
                    riskLevelDist: {},
                    avgRiskLevel: null,
                };

                const payload = builder(snapshot, provinceSummary);

                expect(payload.type).toBe('fire_risk_completed');
                expect(payload.channel).toBe('system');
                expect(payload.title).toBe('Đã cập nhật dữ liệu nguy cơ cháy rừng ngày 2026-05-20');
                expect(payload.body).toContain('Cấp: —–— (TB —)');
                expect(payload.data.minLevel).toBeNull();
                expect(payload.data.maxLevel).toBeNull();
                expect(payload.data.avgLevel).toBeNull();
            });

            test('handles Date object correctly in date formatting', () => {
                const snapshot = { id: 104, analysis_date: new Date('2026-06-10T12:00:00.000Z') };
                const payload = builder(snapshot, { riskLevelDist: { 2: 10 } });

                expect(payload.title).toBe('Đã cập nhật dữ liệu nguy cơ cháy rừng ngày 2026-06-10');
            });
        });
    });
});
