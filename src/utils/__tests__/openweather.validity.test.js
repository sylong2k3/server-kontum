'use strict';
const {getWindGrid}=require('../openweather.client');
const originalFetch=global.fetch;
afterAll(()=>{global.fetch=originalFetch;});
function setEntries(entries){global.fetch=jest.fn(async()=>({ok:true,json:async()=>entries}));}
const entry=(speed,deg,time='2026-10-15T09:00')=>({latitude:14,longitude:108,current:{wind_speed_10m:speed,wind_direction_10m:deg,time}});
test('F31 missing wind is null; real calm is zero even without direction',async()=>{
 setEntries([entry(null,null),entry(0,null),entry(10,90),entry(5,null)]);
 const r=await getWindGrid([107,13,108,14],2);
 expect(r.unit).toBe('m/s');expect(global.fetch.mock.calls[0][0]).toContain('wind_speed_unit=ms');
 expect(r.points[0]).toMatchObject({speed:null,deg:null,u:null,v:null,valid:false});
 expect(r.points[1]).toMatchObject({speed:0,deg:null,u:0,v:0,valid:true});
 expect(r.points[2]).toMatchObject({speed:10,u:-10,valid:true});
 expect(r.points[3]).toMatchObject({speed:5,u:null,v:null,valid:false});expect(r.validPointCount).toBe(2);
 expect(r.observedAt).toBe('2026-10-15T09:00:00.000Z');expect(r.points[0].observationAgeSeconds).toEqual(expect.any(Number));
});
test('missing timestamps are explicit, not fetchedAt masquerading as observation time',async()=>{
 setEntries([entry(1,0,null),entry(1,0),entry(1,0),entry(1,0)]);const r=await getWindGrid([107,13,108,14],2);
 expect(r.observedAt).toBeNull();expect(r.freshness.missingTimestampCount).toBe(1);expect(r.points[0].observationAgeSeconds).toBeNull();
});
test('missing grid entries are rejected, not a successful complete grid',async()=>{
 setEntries([entry(1,0)]);await expect(getWindGrid([107,13,108,14],2)).rejects.toThrow('cardinality');
});
test('malformed wind finite/physical fields remain invalid',async()=>{
 setEntries([entry(NaN,0),entry(-1,0),entry(5,361),entry(Infinity,0)]);const r=await getWindGrid([107,13,108,14],2);expect(r.validPointCount).toBe(0);expect(r.points.every(p=>p.u===null)).toBe(true);
});
