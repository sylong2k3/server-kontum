'use strict';
jest.mock('../../configs/database',()=>({query:jest.fn()}));
jest.mock('../../repositories/weather.repository',()=>({getFresh:jest.fn(),getLatest:jest.fn(),upsert:jest.fn()}));
jest.mock('../openweather.client',()=>({getWindGrid:jest.fn()}));
const db=require('../../configs/database');
const gt=require('../../repositories/forest-gt.repository');
const fire=require('../../repositories/fire-risk.repository');
const forest=require('../../repositories/forest-classification.repository');
const weatherRepo=require('../../repositories/weather.repository');
const owm=require('../openweather.client');
const weather=require('../../services/weather.service');
beforeEach(()=>jest.resetAllMocks());
test('G6 GT database boundary retains canonical class and observed date; counts are features, not effective pixels',async()=>{
 const geom={type:'Point',coordinates:[108,14]};
 db.query.mockResolvedValueOnce({rows:[{id:1,class_id:5,observed_at:'2025-01-02',geom}]}).mockResolvedValueOnce({rows:[{id:2,class_id:0,observed_at:'2025-01-03',geom,lng:108,lat:14}]});
 const from=new Date('2025-01-01Z'),to=new Date('2025-02-01Z');const result=await gt.getGtForWindow({from,to});
 expect(result.counts).toEqual({zones:1,points:1,byClass:{0:1,5:1}});expect(result.zones.features[0].properties.class).toBe(5);
 expect(result.points.features[0].properties.class).toBe(0);
 for(const [sql,params] of db.query.mock.calls){expect(sql).toContain('is_active = TRUE');expect(sql).toContain('observed_at >= $1 AND observed_at < $2');expect(params).toEqual([from,to]);}
});
test.each([['forest',forest],['fire',fire]])('G5 %s district readiness does not require province layer',async(name,repo)=>{
 db.query.mockResolvedValue({rows:[{id:'s',status:'published',geoserver_layer:null}]});
 const row=await repo.markPublishedIfDistrictsReady('s',10);
 expect(row).toMatchObject({status:'published',geoserver_layer:null});
 const [sql,params]=db.query.mock.calls[0];expect(params).toEqual(['s',10]);
 expect(sql).toMatch(/COUNT\(DISTINCT/);expect(sql).toMatch(/d.geoserver_layer/);expect(sql).toMatch(/d.minio_key/);expect(sql).not.toMatch(/s.geoserver_layer\s+IS NOT NULL/);
});
test('F31 versioned weather cache bypasses old semantics; real stale fallback remains explicit',async()=>{
 weatherRepo.getFresh.mockResolvedValue(null);owm.getWindGrid.mockResolvedValue({observedAt:null,points:[{u:null,v:null,speed:null}]});weatherRepo.upsert.mockResolvedValue({});
 const result=await weather.getWindGrid({bbox:'107,13,108,14',grid:2,lang:'vi'});
 expect(weatherRepo.getFresh.mock.calls[0][0]).toContain('wind_grid:v2-validity:');expect(result.points[0].u).toBeNull();expect(result.stale).toBe(false);
 owm.getWindGrid.mockRejectedValue(new Error('upstream'));weatherRepo.getLatest.mockResolvedValue({payload:{points:[{u:0,v:0,speed:0}]},fetched_at:'2025-01-01'});
 const stale=await weather.getWindGrid({bbox:'107,13,108,14',grid:2,lang:'vi'});expect(stale.stale).toBe(true);expect(stale.points[0].speed).toBe(0);
});
