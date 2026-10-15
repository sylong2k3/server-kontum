'use strict';
const { normalizeParams } = require('../satellite-request.util');
const { effectiveNdviThreshold, ndviCacheHash } = require('../satellite-identity.util');
const request = extra => normalizeParams({ imageType: 'ndvi', startDate: '2025-01-01', endDate: '2025-02-01', geometry: { type:'Point', coordinates:[108,14] }, ...extra });
describe('F20 NDVI versioned bundle identity', () => {
    test('threshold .3/.8 separated; default/explicit equivalent; zero retained', () => {
        expect(ndviCacheHash(request({ndviMinThresh:.3}))).not.toBe(ndviCacheHash(request({ndviMinThresh:.8})));
        expect(ndviCacheHash(request())).toBe(ndviCacheHash(request({ndviMinThresh:'0.3'})));
        expect(request({ndviMinThresh:0}).ndviMinThresh).toBe(0);
        expect(ndviCacheHash(request({ndviMinThresh:0}))).not.toBe(ndviCacheHash(request()));
    });
    test('repeated equivalent dataset case and irrelevant fields have same identity', () => {
        expect(ndviCacheHash(request({collection:'s2',month:1}))).toBe(ndviCacheHash(request({collection:'S2',month:2,groundTruthAssetId:'unused'})));
    });
    test.each([{collection:'S2'}, {endDate:'2025-03-01'}, {geometry:{type:'Point',coordinates:[109,14]}}, {cloudCover:10}])('output-dependent input %j differs', extra => {
        expect(ndviCacheHash(request(extra))).not.toBe(ndviCacheHash(request()));
    });
    test('processing version separated', () => expect(ndviCacheHash(request(),'v1')).not.toBe(ndviCacheHash(request(),'v2')));
    test.each([NaN,Infinity,'','bad',true,{}])('invalid explicit input %j rejected', value => expect(()=>effectiveNdviThreshold(value)).toThrow());
    test('existing finite negative threshold is not silently rejected or changed', () => expect(effectiveNdviThreshold(-.2)).toBe(-.2));
});
