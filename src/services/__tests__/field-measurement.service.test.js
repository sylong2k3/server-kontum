'use strict';

// Idempotency của POST /field-measurements theo clientUuid.
// Kịch bản: app hiện trường mất sóng NGAY SAU KHI server đã commit (transaction
// COMMIT thành công) nhưng response chưa kịp về máy — app coi là timeout và tự
// động gửi lại cùng payload + cùng clientUuid.
//
//   1) "fast path"    — retry chạy sau khi bản ghi đã commit hẳn: pre-check
//                        SELECT tìm thấy ngay, bỏ qua toàn bộ tính toán geom/layer.
//   2) "DB-level race" — retry (hoặc request trùng) chạy đúng vào khe hở giữa
//                        pre-check và INSERT của request gốc: pre-check không
//                        thấy gì, nhưng INSERT ... ON CONFLICT DO NOTHING ở tầng
//                        DB chặn lại — service phải fallback sang SELECT trong
//                        cùng transaction, KHÔNG được gọi assignCode (tránh ghi
//                        đè code của bản ghi đã tồn tại), và KHÔNG được throw.
//
// Đây là unit test theo tầng "service" (docs/11-test-qa-strategy.md §2) — mock
// toàn bộ repository/db, không cần Postgres thật. Postgres đảm bảo tính atomic
// của UNIQUE index (migration 038); phần cần test ở đây là service phản ứng
// đúng khi DB báo conflict.

// Factory explicite cho các module có side-effect khi require thật (pg Pool,
// MinIO client, websocket server, Firebase push...) — tránh automock phải require
// bản gốc chỉ để soi hình dạng export. field-measurement.repository dùng automock
// bình thường vì nó chỉ require '../configs/database' (đã mock ở trên, hoisted).
jest.mock('../../configs/database', () => ({
    pool: { connect: jest.fn() },
    query: jest.fn(),
    getClient: jest.fn(),
}));
jest.mock('../../repositories/field-measurement.repository');
jest.mock('../../repositories/monitored-area.repository', () => ({}));
jest.mock('../../repositories/map-layer.repository', () => ({}));
jest.mock('../minio.service', () => ({}));
jest.mock('../notification.service', () => ({ broadcastToRole: jest.fn(), sendToUser: jest.fn() }));
// Package 'uuid' (v14) chỉ publish ESM cho 'require()' trong node_modules cài ở máy này,
// Jest (CJS transform) không parse được — mock thẳng, service chỉ dùng v4() ở addPhoto
// (không nằm trong phạm vi test này).
jest.mock('uuid', () => ({ v4: () => 'mocked-uuid-v4' }));

const db = require('../../configs/database');
const repo = require('../../repositories/field-measurement.repository');
const service = require('../field-measurement.service');

const ACTOR = { id: 42, role: 'so_nnmt' };

const VALID_POINTS = [
    { lng: 108.0, lat: 14.35, accuracy_m: 5 },
    { lng: 108.001, lat: 14.35, accuracy_m: 5 },
    { lng: 108.001, lat: 14.351, accuracy_m: 5 },
];

const GEOM = {
    type: 'Polygon',
    coordinates: [[[108, 14.35], [108.001, 14.35], [108.001, 14.351], [108, 14.35]]],
};

const makeFakeClient = () => ({
    query: jest.fn().mockResolvedValue({}),
    release: jest.fn(),
});

describe('field-measurement.service.createMeasurement — idempotency theo clientUuid', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        repo.buildValidPolygon.mockResolvedValue({ geom: GEOM, areaM2: 120.5, avgAccuracyM: 5 });
        repo.isWithinProvince.mockResolvedValue(true);
        repo.findCommuneCode.mockResolvedValue('KT-01');
        db.pool = { connect: jest.fn() };
    });

    test('retry sau khi đã commit (fast path): pre-check trả về bản ghi cũ, không tính lại geom/tạo mới', async () => {
        // Lần 1 — chưa có bản ghi nào theo clientUuid.
        repo.findByClientUuid.mockResolvedValueOnce(null);
        db.pool.connect.mockResolvedValueOnce(makeFakeClient());
        repo.create.mockResolvedValueOnce({ id: 1, client_uuid: 'uuid-1' });
        repo.assignCode.mockResolvedValueOnce({ id: 1, code: 'DD-2026-00001', client_uuid: 'uuid-1' });

        const first = await service.createMeasurement(ACTOR, { points: VALID_POINTS, clientUuid: 'uuid-1' }, 'vi');
        expect(first.duplicated).toBe(false);
        expect(first.measurement.id).toBe(1);

        // Lần 2 — app timeout ở lần 1 (dù server đã COMMIT) và tự động gửi lại
        // nguyên payload với cùng clientUuid.
        repo.findByClientUuid.mockResolvedValueOnce({ id: 1, code: 'DD-2026-00001', client_uuid: 'uuid-1' });

        const second = await service.createMeasurement(ACTOR, { points: VALID_POINTS, clientUuid: 'uuid-1' }, 'vi');

        expect(second.duplicated).toBe(true);
        expect(second.measurement.id).toBe(1);
        // Không tạo bản ghi mới, không tính lại polygon — pre-check đã short-circuit.
        expect(repo.create).toHaveBeenCalledTimes(1);
        expect(repo.buildValidPolygon).toHaveBeenCalledTimes(1);
        expect(db.pool.connect).toHaveBeenCalledTimes(1);
    });

    test('retry rơi đúng khe hở race (DB conflict): ON CONFLICT chặn INSERT, service fallback sang SELECT thay vì tạo trùng', async () => {
        // Pre-check chạy trước khi request gốc kịp COMMIT -> không thấy gì, vẫn đi
        // tiếp vào transaction như một phiên đo mới.
        repo.findByClientUuid
            .mockResolvedValueOnce(null) // pre-check ngoài transaction
            .mockResolvedValueOnce({ id: 7, code: 'DD-2026-00007', client_uuid: 'uuid-2' }); // fallback trong transaction

        db.pool.connect.mockResolvedValueOnce(makeFakeClient());
        // INSERT ... ON CONFLICT (measured_by, client_uuid) DO NOTHING -> không có row trả về.
        repo.create.mockResolvedValueOnce(null);

        const result = await service.createMeasurement(ACTOR, { points: VALID_POINTS, clientUuid: 'uuid-2' }, 'vi');

        expect(result.duplicated).toBe(true);
        expect(result.measurement.id).toBe(7);
        // Không được đè lại code của bản ghi đã tồn tại (assignCode gán theo năm hiện tại
        // + id — chạy lại trên bản ghi cũ sẽ sai nếu bản ghi tạo ở năm khác).
        expect(repo.assignCode).not.toHaveBeenCalled();
    });

    test('không có clientUuid: tạo bình thường, không pre-check, không lỗi', async () => {
        db.pool.connect.mockResolvedValueOnce(makeFakeClient());
        repo.create.mockResolvedValueOnce({ id: 99, client_uuid: null });
        repo.assignCode.mockResolvedValueOnce({ id: 99, code: 'DD-2026-00099', client_uuid: null });

        const result = await service.createMeasurement(ACTOR, { points: VALID_POINTS }, 'vi');

        expect(result.duplicated).toBe(false);
        expect(result.measurement.id).toBe(99);
        expect(repo.findByClientUuid).not.toHaveBeenCalled();
    });
});
