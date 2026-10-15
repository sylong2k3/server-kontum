'use strict';
function load(){
 jest.resetModules();const trace=[];const calls=[];
 function date(value){const d=value?.d?new Date(value.d):new Date(value);return {d,advance(n,unit){const x=new Date(d);if(unit==='month')x.setUTCMonth(x.getUTCMonth()+n);else x.setUTCDate(x.getUTCDate()+n);return date(x);},toString(){return d.toISOString().slice(0,10);}};}
 const image=new Proxy(function(){return image;},{get(target,key){if(key==='then')return undefined;if(key==='stratifiedSample')return options=>{calls.push(options);return image;};if(key==='select')return bands=>{trace.push({select:bands});return image;};if(key==='map')return fn=>{fn(image);return image;};if(key==='set')return values=>{trace.push({set:values});return image;};if(key==='toList')return ()=>({iterate:()=>image});return ()=>image;}});
 function collection(id){return new Proxy({}, {get(target,key){if(key==='filterDate')return(s,e)=>{trace.push({id,start:String(s),end:String(e)});return collection(id);};if(key==='map')return fn=>{fn(image);return collection(id);};if(key==='size')return()=>({gt:()=>true});if(key==='toList')return()=>({iterate:()=>image});if(['median','mean','sum','first','max'].includes(key))return()=>image;return()=>collection(id);}});}
 const ee={Date:date,Image:image,ImageCollection:collection,Algorithms:{If:(c,a,b)=>c?a:b},Filter:{lte:()=>({})},Reducer:{min:()=>({})},List:{sequence:(a,b)=>Array.from({length:b-a+1},(_,i)=>i+a)}};
 jest.doMock('../../configs/gge',()=>({ee}));const forbidden=jest.fn(()=>{throw Error('REMOTE_FORBIDDEN');});jest.doMock('../../utils/gee-satellite.util',()=>({eeGetInfo:forbidden,eeEval:forbidden}));
 return {trace,calls,image,forbidden,fire:require('../fire-risk.pipeline'),forest:require('../forest-classification.pipeline')};
}
test.each([['2026-03-01','2026-01-30','2025-08-03'],['2024-03-01','2024-01-31','2023-08-04'],['2026-01-01','2025-12-02','2025-06-05']])('actual fire builder anchor %s keeps preceding fallback and exclusive end', (anchor,start,fallback)=>{
 const {fire,trace,image,forbidden}=load();fire.getPredictorImage({},anchor,true,{terrain:{slope:image,aspectExposure:image},fuel:{fuelK:image}});
 for(const id of ['COPERNICUS/S2_SR_HARMONIZED','MODIS/061/MOD11A1']){
 expect(trace).toContainEqual({id,start,end:anchor});expect(trace).toContainEqual({id,start:fallback,end:start});}
 expect(trace).toContainEqual({id:'ECMWF/ERA5_LAND/DAILY_AGGR',start,end:anchor});
 expect(trace).toContainEqual({select:fire.PREDICTOR_BANDS});
 expect(fire.PREDICTOR_BANDS).toEqual(expect.arrayContaining([...fire.RF_PREDICTOR_BANDS,'S2_ObservedWindow','LST_ObservedWindow','S2_FallbackWindow','LST_FallbackWindow']));
 expect(forbidden).not.toHaveBeenCalled();
});
test('actual GT sampler paints canonical class, retains source/split, uses mask/dropNulls, not feature counts',()=>{
 const {forest,calls,trace,image,forbidden}=load();const quotas=Array(13).fill(2);forest.sampleGT(image,{},quotas,{},30,42,'train');
 expect(calls[0]).toMatchObject({classBand:'class',classValues:Array.from({length:13},(_,i)=>i),classPoints:quotas,scale:30,seed:42,dropNulls:true,geometries:true});
 expect(trace).toContainEqual({set:{src:'gt',split:'train'}});expect(forbidden).not.toHaveBeenCalled();
});
