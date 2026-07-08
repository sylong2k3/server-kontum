'use strict';

/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.test.js'],
    testPathIgnorePatterns: ['/node_modules/'],
    collectCoverageFrom: [
        'src/utils/gee-satellite.util.js',
        'src/services/satellite.service.js',
        'src/services/forest-classification.service.js',
        'src/services/fire-risk.service.js',
        'src/repositories/satellite.repository.js',
    ],
    coverageReporters: ['text', 'lcov'],
    // Timeout per test: GEE mocks are fast but allow generous headroom.
    testTimeout: 10000,
};
