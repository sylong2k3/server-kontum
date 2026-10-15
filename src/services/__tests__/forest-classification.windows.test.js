'use strict';
function makeEe() {
    const trace = [];
    const acquisitions = ['2025-01-01','2025-01-31','2025-02-01','2025-03-01','2025-03-31','2025-04-01','2024-02-29','2024-03-01'];
    function date(value) {
        if (value?.iso) return value;
        const time = new Date(value).getTime();
        return { iso: new Date(time).toISOString().slice(0,10),
            advance(n, unit) { if (unit !== 'month') throw new Error('Unexpected date unit'); const d = new Date(time); return date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+n,1)); },
            difference(other, unit) { if (unit !== 'day') throw new Error('Unexpected difference unit'); return { lt: n => (time-Date.parse(date(other).iso))/86400000<n }; },
            format: () => new Date(time).toISOString().slice(0,7) };
    }
    date.fromYMD=(y,m,d)=>date(Date.UTC(y,m-1,d));
    function image() {
        const im={};
        for (const method of ['select','add','subtract','multiply','divide','where','abs','lt','clamp','rename','toFloat','clip','mask','reduce','unmask','expression','sin','cos','addBands','reduceNeighborhood']) im[method]=()=>image();
        return im;
    }
    image.constant=()=>image();
    function collection(id,values=acquisitions,depth=0) {
        return { values, filterBounds(){return this;},filter(){return this;},map(){return this;},select(){return this;},
            filterDate(start,end) { const s=date(start).iso,e=date(end).iso;const selected=values.filter(t=>t>=s&&t<e);trace.push({id,depth,start:s,end:e,selected});return collection(id,selected,depth+1); },
            merge(other){return collection('master',[...new Set([...values,...other.values])],1);},median:()=>image(),size:()=>values.length };
    }
    return { trace, ee:{Date:date,Algorithms:{If:(c,a,b)=>c?a:b},Image:image,ImageCollection:id=>collection(id),Filter:{lt:()=>({})},Reducer:{min:()=>({}),stdDev:()=>({})},Kernel:{square:()=>({})},Terrain:{slope:image,aspect:image}} };
}
function load(overrides={}) {
    jest.resetModules();const mock=makeEe();
    const config={...jest.requireActual('../../configs/forest-classification'),...overrides};
    jest.doMock('../../configs/forest-classification',()=>config);
    jest.doMock('../../configs/gge',()=>({ee:mock.ee}));
    const remote=jest.fn(()=>{throw new Error('Remote forbidden');});
    jest.doMock('../../utils/gee-satellite.util',()=>({eeEval:remote,eeGetInfo:remote}));
    jest.doMock('../../utils/stage-logger.util',()=>({makeStageLogger:jest.fn()}));
    return {...mock,remote,pipeline:require('../forest-classification.pipeline')};
}
const starts=['2025-01-01','2025-03-01','2025-03-01','2025-05-01','2025-06-01','2025-07-01','2025-08-01','2025-09-01','2025-09-01','2025-09-01','2025-12-01','2026-01-01'];
describe('F01 actual buildFeatureImage date support',()=>{
    test.each(starts.map((start,i)=>[i+1,start]))('anchor month %i covers all required windows',(month,start)=>{
        const {pipeline,trace,remote}=load();const result=pipeline.buildFeatureImage(2026,month,{});
        const end=month===12?'2027-01-01':`2026-${String(month+1).padStart(2,'0')}-01`;
        const roots=trace.filter(t=>t.depth===0);expect(roots).toHaveLength(3);
        roots.forEach(r=>expect(r).toMatchObject({start,end}));
        const children=trace.filter(t=>t.id==='master');expect(children).toHaveLength(5);
        children.forEach(c=>{expect(c.start>=start).toBe(true);expect(c.end<=end).toBe(true);});
        expect(result.windows).toHaveProperty('recent');expect(remote).not.toHaveBeenCalled();
    });
    test.each([[1,'2025-01-01','2025-03-01'],[3,'2025-03-01','2025-05-01']])('anchor %i restores missing observations',(month,start,end)=>{
        const {pipeline,trace}=load();pipeline.buildFeatureImage(2026,month,{});
        const season=trace.find(t=>t.id==='master'&&t.start===start&&t.end===end);
        expect(season.selected).toContain(start);expect(season.selected).not.toContain(end);
        expect((Date.parse(month===1?'2025-02-01':'2025-04-01')-Date.parse(start))/86400000).toBe(31);
    });
    test('leap day included, exclusive March 1 excluded',()=>{
        const {pipeline,trace}=load();pipeline.buildFeatureImage(2024,2,{});
        const f=trace.find(t=>t.id==='master'&&t.start==='2024-01-01'&&t.end==='2024-03-01');
        expect(f.selected).toContain('2024-02-29');expect(f.selected).not.toContain('2024-03-01');
    });
    test.each([
        [{WIN_BASE_MONTHS:24},6,'2024-07-01'],
        [{WIN_BASE_MONTHS:6,WIN_RECENT_MONTHS:18},6,'2025-01-01'],
        [{WIN_BASE_MONTHS:1,WIN_RECENT_MONTHS:1,WIN_GREEN_START:1,WIN_GREEN_END:2,WIN_DRY_START:3,WIN_DRY_END:4,WIN_DEFOL_START:5,WIN_DEFOL_END:6},1,'2025-01-01'],
        [{WIN_BASE_MONTHS:1,WIN_RECENT_MONTHS:1,WIN_GREEN_START:5,WIN_GREEN_END:6,WIN_DRY_START:1,WIN_DRY_END:2,WIN_DEFOL_START:7,WIN_DEFOL_END:8},1,'2025-01-01'],
        [{WIN_BASE_MONTHS:1,WIN_RECENT_MONTHS:1,WIN_GREEN_START:5,WIN_GREEN_END:6,WIN_DRY_START:7,WIN_DRY_END:8,WIN_DEFOL_START:1,WIN_DEFOL_END:2},1,'2025-01-01'],
    ])('configurable earliest period %j',(cfg,month,start)=>{const {pipeline,trace}=load(cfg);pipeline.buildFeatureImage(2026,month,{});expect(trace.filter(t=>t.depth===0).every(t=>t.start===start)).toBe(true);});
    test.each([[2025,12,'2026-01-01'],[2026,12,'2027-01-01'],[2027,1,'2027-02-01']])('rollover %i/%i',(year,month,end)=>{const {pipeline,trace}=load();pipeline.buildFeatureImage(year,month,{});expect(trace.filter(t=>t.depth===0).every(t=>t.end===end)).toBe(true);});
    test.each([2012,2015,2016])('historical dispatch %i',year=>{const {pipeline,trace}=load();pipeline.buildFeatureImage(year,3,{});expect(trace.filter(t=>t.depth===0)).toHaveLength(year<=2012?4:year>=2016?3:2);});
    test.each([true,false])('texture %s preserves dates',flag=>{const {pipeline,trace}=load({USE_TEXTURE:flag});expect(pipeline.buildFeatureImage(2026,1,{}).hasTexture).toBe(flag);expect(trace[0].start).toBe('2025-01-01');});
});
