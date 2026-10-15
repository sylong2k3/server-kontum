'use strict';
jest.mock('../../repositories/weather.repository',()=>({getFresh:jest.fn(),getLatest:jest.fn(),upsert:jest.fn()}));
jest.mock('../../utils/openweather.client',()=>({getWindGrid:jest.fn()}));
const repo=require('../../repositories/weather.repository');const owm=require('../../utils/openweather.client');const service=require('../weather.service');
beforeEach(()=>{jest.resetAllMocks();jest.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-15T10:00:00Z'));});afterEach(()=>jest.restoreAllMocks());
const payload={unit:'m/s',fetchedAt:'2026-10-15T08:00:00Z',points:[{u:0,v:0,speed:0,observedAt:'2026-10-15T07:00:00Z',observationAgeSeconds:3600},{u:null,v:null,speed:null,observedAt:null,observationAgeSeconds:null}]};
test.each([true,false])('wind age reflects serving time on cache fresh=%s without mutating stored payload',async fresh=>{
 const record={payload:JSON.parse(JSON.stringify(payload)),fetched_at:payload.fetchedAt};
 repo.getFresh.mockResolvedValue(fresh?record:null);repo.getLatest.mockResolvedValue(record);owm.getWindGrid.mockRejectedValue(new Error('offline'));
 const r=await service.getWindGrid({bbox:'107,13,108,14',grid:2,lang:'vi'});
 expect(r.points[0].observationAgeSeconds).toBe(10800);expect(r.points[1].observationAgeSeconds).toBeNull();expect(r.points[0].speed).toBe(0);
 expect(r.freshness.ageEvaluatedAt).toBe('2026-10-15T10:00:00.000Z');expect(record.payload.points[0].observationAgeSeconds).toBe(3600);expect(r.stale).toBe(!fresh);
});
