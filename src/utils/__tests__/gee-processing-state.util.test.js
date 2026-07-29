'use strict';

const queue = require('../../queues/gee-task.queue');
const {
    buildGeeProcessingState,
    normalizeDistrictExport,
} = require('../gee-processing-state.util');

describe('gee-processing-state', () => {
    beforeEach(() => {
        queue.start();
    });

    afterEach(async () => {
        await queue.onIdle();
        queue.stop();
    });

    test('trả đúng vị trí khi pipeline còn một tác vụ GEE phía trước', async () => {
        let releaseFirst;
        const first = queue.enqueue({
            key: 'analysis:forest-classification:test-period',
            label: 'Forest test',
            priority: 100,
            run: () => new Promise((resolve) => {
                releaseFirst = resolve;
            }),
        });
        const second = queue.enqueue({
            key: 'analysis:fire-risk:test-date',
            label: 'Fire test',
            priority: 100,
            run: async () => null,
        });

        await new Promise((resolve) => setImmediate(resolve));
        const state = buildGeeProcessingState({
            pipeline: 'fire-risk',
            taskKey: 'analysis:fire-risk:test-date',
        });

        expect(state.state).toBe('queued');
        expect(state.queue.position).toBe(2);
        expect(state.queue.jobsAhead).toBe(1);
        expect(state.queue.activePipeline).toBe('forest-classification');

        releaseFirst();
        await Promise.all([first, second]);
    });

    test('tách tiến độ raster huyện khỏi trạng thái snapshot completed', async () => {
        let releaseRun;
        const activeRun = queue.enqueue({
            key: 'analysis:fire-risk:export-test',
            label: 'Fire export test',
            priority: 100,
            run: () => new Promise((resolve) => {
                releaseRun = resolve;
            }),
        });
        await new Promise((resolve) => setImmediate(resolve));

        const districtExport = normalizeDistrictExport({
            total: 10,
            completed: 3,
            failed: 0,
            skipped: 0,
            pending: 7,
        });
        const state = buildGeeProcessingState({
            pipeline: 'fire-risk',
            snapshot: {
                status: 'completed',
                district_export_summary: districtExport,
            },
        });

        expect(state.state).toBe('exporting');
        expect(state.queue.status).toBe('running');
        expect(state.districtExport.status).toBe('running');
        expect(state.districtExport.progressPercent).toBe(30);

        releaseRun();
        await activeRun;
    });

    test('chặn chạy lại ngay sau khi cùng tác vụ vừa hoàn tất', async () => {
        const key = 'analysis:fire-risk:cooldown-test';
        await queue.enqueue({
            key,
            label: 'Cooldown test',
            run: async () => null,
        });

        expect(() => queue.preflight({ key, cooldownMs: 60 * 1000 }))
            .toThrow(expect.objectContaining({
                status: 429,
                errors: ['GEE_TASK_COOLDOWN'],
            }));
    });

    test('từ chối task mới khi queue đã đạt giới hạn pending', async () => {
        let releaseActive;
        const active = queue.enqueue({
            key: 'analysis:fire-risk:capacity-active',
            label: 'Capacity active',
            run: () => new Promise((resolve) => {
                releaseActive = resolve;
            }),
        });
        await new Promise((resolve) => setImmediate(resolve));

        const queued = [];
        const { maxPending } = queue.getState();
        try {
            for (let index = 0; index < maxPending; index += 1) {
                queued.push(queue.enqueue({
                    key: `analysis:forest-classification:capacity-${index}`,
                    label: `Capacity ${index}`,
                    run: async () => null,
                }));
            }

            expect(() => queue.preflight({
                key: 'analysis:fire-risk:capacity-overflow',
            })).toThrow(expect.objectContaining({
                status: 503,
                errors: ['GEE_QUEUE_FULL'],
            }));
        } finally {
            releaseActive();
        }

        await Promise.all([active, ...queued]);
    });
});
