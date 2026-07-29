'use strict';

const express = require('express');
const request = require('supertest');
const {
    geeQueryLimiter,
} = require('../gee-rate-limit.middleware');

describe('GEE trigger rate limit', () => {
    test('chặn quét hàng loạt kỳ phân loại theo IP', async () => {
        const app = express();
        app.set('trust proxy', 1);
        app.post('/query', geeQueryLimiter, (req, res) => {
            res.json({ ok: true });
        });

        for (let index = 0; index < 12; index += 1) {
            await request(app)
                .post('/query')
                .set('X-Forwarded-For', '203.0.113.10')
                .expect(200);
        }
        const blocked = await request(app)
            .post('/query')
            .set('X-Forwarded-For', '203.0.113.10')
            .expect(429);

        expect(blocked.body.errors).toContain('GEE_QUERY_RATE_LIMITED');
        expect(blocked.headers['ratelimit-policy']).toBeDefined();
    });
});
