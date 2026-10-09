const express = require('express');
const request = require('supertest');
const { requirePermission, hasPermission } = require('../auth.middleware');

const makeApp = (user) => {
    const app = express();
    app.use((req, res, next) => { req.user = user; req.lang = 'vi'; next(); });
    app.get('/history', requirePermission('fire_risk', 'manage'), (req, res) => res.json({ allowed: true }));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message }));
    return app;
};

describe('RBAC HTTP boundary (isolated test identity, no production mutations)', () => {
    test('no identity is 401', async () => {
        await request(makeApp(null)).get('/history').expect(401);
    });
    test('read-only UBND is 403, not 401', async () => {
        await request(makeApp({ role: 'ubnd_tinh', role_permissions: { fire_risk: { read: true } } }))
            .get('/history').expect(403);
    });
    test('manager permission permits access', async () => {
        await request(makeApp({ role: 'so_nnmt', role_permissions: { fire_risk: { manage: true } } }))
            .get('/history').expect(200, { allowed: true });
    });
    test('system admin retains the existing bypass', async () => {
        await request(makeApp({ role: 'system_admin', role_permissions: {} }))
            .get('/history').expect(200);
    });
    test('explicit denial is authoritative even for So role', async () => {
        await request(makeApp({ role: 'so_nnmt', role_permissions: { fire_risk: { manage: false } } }))
            .get('/history').expect(403);
    });
    test('only literal true grants an action', () => {
        expect(hasPermission({ fire_risk: { manage: 'true' } }, 'fire_risk', 'manage')).toBe(false);
        expect(hasPermission(null, 'fire_risk', 'manage')).toBe(false);
    });
});
