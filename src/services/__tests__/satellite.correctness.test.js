'use strict';
process.env.GEE_GCS_BUCKET = 'test-only';
jest.mock('../../configs/gge', () => ({ ee: {}, initializeEarthEngine: jest.fn(async()=>{}) }));
jest.mock('../../repositories/satellite.repository', () => ({ getByHash:jest.fn(), upsert:jest.fn(), getById:jest.fn(), listExporting:jest.fn(), updatePublish:jest.fn() }));
jest.mock('../../utils/gee-satellite.util', () => ({ eeEval:jest.fn(), getEeMapId:jest.fn(async()=>({mapId:'map',tileUrl:'tile'})), getEeDownloadUrl:jest.fn(async()=>({url:'download'})), toEeGeometry:jest.fn(g=>g), maskS2:jest.fn(), maskLandsatC2:jest.fn(), prepL89:jest.fn() }));
jest.mock('../forest-classification.pipeline', () => ({ runRfClassification:jest.fn() }));
jest.mock('../fire-risk.pipeline', () => ({ runFireRiskAnalysis:jest.fn() }));
jest.mock('../../utils/gee-export.helper', () => ({ pollGeeTask:jest.fn(), publishRasterToMinio:jest.fn() }));
jest.mock('../../utils/geoserver.client', () => ({ publishS3GeoTiffLayer:jest.fn() }));
const repo=require('../../repositories/satellite.repository');
const util=require('../../utils/gee-satellite.util');
const {ee}=require('../../configs/gge');
const exp=require('../../utils/gee-export.helper');
const gs=require('../../utils/geoserver.client');
const {effectiveRequest,scientificSignature}=require('../../utils/satellite-provenance.util');
const service=require('../satellite.service');
const base={startDate:'2025-01-01',endDate:'2025-02-01',geometry:{type:'Point',coordinates:[108,14]}};
let image;
beforeEach(()=>{
 jest.resetAllMocks();
 util.getEeMapId.mockResolvedValue({mapId:'map',tileUrl:'tile'});
 util.getEeDownloadUrl.mockResolvedValue({url:'download'});
 util.toEeGeometry.mockImplementation(g=>g);
 image={};
 for(const key of ['filter','filterBounds','filterDate','map','merge','median','clip','select','normalizedDifference','rename','gt','selfMask','toByte','divide','addBands','reduceRegion','mean','multiply','subtract','toFloat']) image[key]=jest.fn(()=>image);
 image.size=jest.fn(()=>image);
 ee.ImageCollection=jest.fn(()=>image); ee.Image={pixelArea:()=>image};
 ee.Filter={lte:jest.fn()};ee.Reducer={sum:()=>({group:()=>({})}),count:()=>({}),mean:()=>({combine:()=>({})}),minMax:()=>({})};
 repo.getByHash.mockResolvedValue(null);repo.upsert.mockImplementation(async p=>({id:'result',...p}));
 repo.updatePublish.mockImplementation(async(id,p)=>({id,...p}));
 exp.pollGeeTask.mockResolvedValue('COMPLETED');exp.publishRasterToMinio.mockResolvedValue({minioKey:'raster.tif'});gs.publishS3GeoTiffLayer.mockResolvedValue('kontum:raster');
 repo.listExporting.mockResolvedValue([{id:'r',image_type:'ndvi',start_date:'2025-01-01',gee_task_id:'task'}]);
 ee.batch={Export:{image:{toCloudStorage:jest.fn(()=>({start:jest.fn(),status:()=>({id:'task'})}))}}};
});
test('F20 actual cache miss, repeated hit, different threshold miss; zero reaches statistics',async()=>{
 const cache=new Map();repo.getByHash.mockImplementation(async key=>cache.get(key));repo.upsert.mockImplementation(async p=>{const r={id:String(cache.size),...p};cache.set(p.request_hash,r);return r;});
 util.eeEval.mockResolvedValueOnce(2).mockResolvedValueOnce({groups:[{class:1,sum:12}]}).mockResolvedValueOnce({NDVI:4});
 const a=await service.getNdvi({...base,ndviMinThresh:0}); expect(a.stats).toMatchObject({ndviThreshUsed:0,vegetationHa:12,validPixels:4});expect(image.gt).toHaveBeenCalledWith(0);
 const b=await service.getNdvi({...base,ndviMinThresh:0});expect(b.cached).toBe(true);expect(repo.upsert).toHaveBeenCalledTimes(1);
 util.eeEval.mockResolvedValueOnce(2).mockResolvedValueOnce({groups:[]}).mockResolvedValueOnce({NDVI:4});
 const c=await service.getNdvi({...base,ndviMinThresh:.8});expect(c.cached).toBe(false);expect(c.stats.vegetationHa).toBe(0);expect(cache.size).toBe(2);
});
test.each([0,null])('F21 masked or missing support %s is not zero vegetation',async support=>{
 util.eeEval.mockResolvedValueOnce(2).mockResolvedValueOnce({groups:[]}).mockResolvedValueOnce({NDVI:support});
 expect((await service.getNdvi(base)).stats.vegetationHa).toBeNull();
});
test('NDVI default and explicit .3 use same cache key',async()=>{
 repo.getByHash.mockResolvedValue({id:'cached',stats:{},metadata:{}});
 await service.getNdvi(base);await service.getNdvi({...base,ndviMinThresh:.3});
 expect(repo.getByHash.mock.calls[0][0]).toBe(repo.getByHash.mock.calls[1][0]);
});
test('missing LST stays null; real zero remains zero and MOD11 scale unchanged',async()=>{
 util.eeEval.mockResolvedValueOnce(1).mockResolvedValueOnce({LST_C_mean:0,LST_C_min:null});
 const r=await service.getHeatmap(base);expect(r.stats).toMatchObject({lstMeanC:0,lstMinC:null,lstMaxC:null});
 expect(image.multiply).toHaveBeenCalledWith(.02);expect(image.subtract).toHaveBeenCalledWith(273.15);expect(image.mean).toHaveBeenCalled();
});
test.each(['getNdvi','getHeatmap','getRgb'])('empty collection rejects %s without cache write',async method=>{
 util.eeEval.mockResolvedValueOnce(0);await expect(service[method](base)).rejects.toThrow();expect(repo.upsert).not.toHaveBeenCalled();
});
test.each(['rgb','ndvi','heatmap','classified','fire-risk'])('F22 nondefault %s preview provenance roundtrips normalization',type=>{
 const raw={...base,imageType:type,collection:'LANDSAT',cloudCover:7,ndviMinThresh:.8,month:1,gtBufferM:75,minFieldTest:16,groundTruthAssetId:'test/GT',enableRf:false,inputFireAssetId:'test/fire',fireLayer:'score'};
 const normalized=service.normalizeParams(raw);const effective=effectiveRequest(normalized);
 expect(scientificSignature(effectiveRequest(service.normalizeParams(effective.params)))).toBe(scientificSignature(effective));
});
test('F22 actual NDVI publish rebuild preserves threshold and signature',async()=>{
 util.eeEval.mockResolvedValueOnce(2).mockResolvedValueOnce({groups:[]}).mockResolvedValueOnce({NDVI:4});await service.getNdvi({...base,ndviMinThresh:.8,cloudCover:7});
 const saved=repo.upsert.mock.calls[0][0];repo.getById.mockResolvedValue(saved);
 util.eeEval.mockResolvedValueOnce(2).mockResolvedValueOnce({groups:[]}).mockResolvedValueOnce({NDVI:4}).mockResolvedValueOnce({id:'task'});
 await service.publishResult('r');expect(image.gt.mock.calls.every(([v])=>v===.8)).toBe(true);expect(ee.batch.Export.image.toCloudStorage).toHaveBeenCalledTimes(1);
});
test('historical missing provenance fails closed without guessing or exporting',async()=>{
 repo.getById.mockResolvedValue({image_type:'ndvi',metadata:{}});await expect(service.publishResult('r')).rejects.toThrow();expect(ee.batch.Export.image.toCloudStorage).not.toHaveBeenCalled();
});
test.each(['FAILED','CANCELLED','TIMEOUT'])('F23 GEE %s never published',async state=>{
 exp.pollGeeTask.mockResolvedValue(state);await service.pollPublishes();expect(repo.updatePublish).toHaveBeenLastCalledWith('r',expect.objectContaining({status:'failed'}));expect(gs.publishS3GeoTiffLayer).not.toHaveBeenCalled();
});
test.each(['download','minio','geoserver'])('F23 %s failure not false published',async boundary=>{
 if(boundary==='geoserver')gs.publishS3GeoTiffLayer.mockRejectedValueOnce(new Error(boundary));else exp.publishRasterToMinio.mockRejectedValueOnce(new Error(boundary));
 await service.pollPublishes();expect(repo.updatePublish).toHaveBeenLastCalledWith('r',expect.objectContaining({status:'failed'}));expect(repo.updatePublish.mock.calls.some(([,p])=>p.status==='published')).toBe(false);
});
test('partial publication retains minio artifact; successful retry and idempotent no-work poll',async()=>{
 gs.publishS3GeoTiffLayer.mockRejectedValueOnce(new Error('GS unavailable'));await service.pollPublishes();
 expect(repo.updatePublish).toHaveBeenCalledWith('r',expect.objectContaining({minio_key:'raster.tif'}));
 await service.pollPublishes();expect(repo.updatePublish).toHaveBeenLastCalledWith('r',expect.objectContaining({status:'published',geoserver_layer:'kontum:raster',publish_error:null}));
 repo.listExporting.mockResolvedValue([]);await service.pollPublishes();expect(gs.publishS3GeoTiffLayer).toHaveBeenCalledTimes(2);
});
test('same-process overlapping polls publish artifact only once',async()=>{
 let resolve;exp.pollGeeTask.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const a=service.pollPublishes();await Promise.resolve();await service.pollPublishes();resolve('COMPLETED');await a;expect(exp.publishRasterToMinio).toHaveBeenCalledTimes(1);
});

test('F27 JSONB property order does not change scientific identity',()=>{
 const e=effectiveRequest(service.normalizeParams({...base,imageType:'ndvi',ndviMinThresh:.8}));
 const reverse=value=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reverse(v)])):value;
 expect(scientificSignature(reverse(e))).toBe(scientificSignature(e));
});

test.each(['rgb','heatmap','classified','fire-risk'])('F22 actual %s rebuild retains nondefault effective scientific request',async type=>{
 ee.Feature=jest.fn(g=>g);ee.FeatureCollection=jest.fn(g=>g);
 const rf=require('../forest-classification.pipeline').runRfClassification;
 rf.mockResolvedValue({classified:image,oobPct:null,testAccuracyPct:null,testKappa:null,quotas:{}});
 const fire=require('../fire-risk.pipeline').runFireRiskAnalysis;
 fire.mockResolvedValue({riskLevel:image,finalFireRiskScore:image,priorityFireWarning:image,modelConfidenceClass:image,
   rfEnabled:false,inputFireAssetId:'test/fire',fuelSource:'test'});
 const args={...base,collection:'LANDSAT',cloudCover:7,month:1,groundTruthAssetId:'test/GT',gtBufferM:75,minFieldTest:16,
   analysisDate:'2025-02-01',enableRf:false,inputFireAssetId:'test/fire',fireLayer:'score'};
 const method={rgb:'getRgb',heatmap:'getHeatmap',classified:'getClassified','fire-risk':'getFireRisk'}[type];
 if(type==='rgb')util.eeEval.mockResolvedValueOnce(3);
 if(type==='heatmap')util.eeEval.mockResolvedValueOnce(3).mockResolvedValueOnce({LST_C_mean:21});
 if(type==='classified')util.eeEval.mockResolvedValueOnce({groups:[]});
 await service[method](args);
 const saved=repo.upsert.mock.calls[0][0];repo.getById.mockResolvedValue(saved);
 if(type==='rgb')util.eeEval.mockResolvedValueOnce(3);
 if(type==='heatmap')util.eeEval.mockResolvedValueOnce(3).mockResolvedValueOnce({LST_C_mean:21});
 if(type==='classified')util.eeEval.mockResolvedValueOnce({groups:[]});
 util.eeEval.mockResolvedValueOnce({id:'task'});
 await service.publishResult('result');
 expect(ee.batch.Export.image.toCloudStorage).toHaveBeenCalledTimes(1);
 expect(saved.metadata.effectiveRequest.params).toMatchObject({cloudCover:7,collection:'LANDSAT'});
 if(type==='classified'){
   expect(rf).toHaveBeenCalledTimes(2);expect(rf.mock.calls[0][3]).toEqual(rf.mock.calls[1][3]);
   expect(rf.mock.calls[1][3]).toMatchObject({month:1,gtBufferM:75,minFieldTest:16,groundTruthAssetId:'test/GT',liteMode:true});
   expect(saved.stats.oobAccuracyPct).toBeNull();
 }
 if(type==='fire-risk'){
   expect(fire).toHaveBeenCalledTimes(2);expect(fire.mock.calls[0][2]).toEqual(fire.mock.calls[1][2]);
   expect(fire.mock.calls[1][2]).toEqual({enableRf:false,inputFireAssetId:'test/fire'});
   expect(saved.stats.fireLayer).toBe('score');
 }
});
test('F22 changed signature fails before new export',async()=>{
 const e=effectiveRequest(service.normalizeParams({...base,imageType:'rgb'}));
 repo.getById.mockResolvedValue({image_type:'rgb',metadata:{effectiveRequest:e,scientificSignature:'old-version'}});
 await expect(service.publishResult('r')).rejects.toThrow();expect(ee.batch.Export.image.toCloudStorage).not.toHaveBeenCalled();
});

// Actual Express route/controller/service boundary; auth/storage/EE are isolated doubles.
jest.mock('../../middlewares/auth.middleware',()=>({optionalAuth:(req,res,next)=>next(),verifyToken:(req,res,next)=>{req.user={id:1};next();},requirePermission:()=>((req,res,next)=>next())}));
jest.mock('../raster-ingest.service',()=>({enqueue:jest.fn()}));
const request=require('supertest');const express=require('express');
const app=express();app.use(express.json());app.use((req,res,next)=>{req.lang='vi';next();});
app.use('/api/v1/satellite',require('../../routes/satellite.routes'));app.use(require('../../middlewares/error-handler').errorHandler);
test.each([0,.3,.8])('HTTP NDVI threshold %s traverses normalizer/cache/builder/response',async threshold=>{
 util.eeEval.mockResolvedValueOnce(2).mockResolvedValueOnce({groups:[]}).mockResolvedValueOnce({NDVI:4});
 const r=await request(app).post('/api/v1/satellite/ndvi').send({...base,ndviMinThresh:threshold});
 expect(r.status).toBe(200);expect(r.body.data.stats).toMatchObject({ndviThreshUsed:threshold,vegetationHa:0,validPixels:4});expect(image.gt).toHaveBeenCalledWith(threshold);
});
test('HTTP invalid threshold is 400 before cache/GEE',async()=>{const r=await request(app).post('/api/v1/satellite/ndvi').send({...base,ndviMinThresh:'bad'});expect(r.status).toBe(400);expect(repo.getByHash).not.toHaveBeenCalled();expect(util.eeEval).not.toHaveBeenCalled();});
test('HTTP masked NDVI stays null and missing LST stays null',async()=>{
 util.eeEval.mockResolvedValueOnce(2).mockResolvedValueOnce({groups:[]}).mockResolvedValueOnce({NDVI:0});
 const ndvi=await request(app).post('/api/v1/satellite/ndvi').send(base);expect(ndvi.body.data.stats.vegetationHa).toBeNull();
 util.eeEval.mockResolvedValueOnce(1).mockResolvedValueOnce({});const lst=await request(app).post('/api/v1/satellite/heat-map').send(base);expect(lst.body.data.stats.lstMeanC).toBeNull();
});
test('HTTP obsolete preview returns actionable 409 with no export',async()=>{repo.getById.mockResolvedValue({image_type:'ndvi',metadata:{}});const r=await request(app).post('/api/v1/satellite/publish').send({resultId:1});expect(r.status).toBe(409);expect(r.body.success).toBe(false);expect(ee.batch.Export.image.toCloudStorage).not.toHaveBeenCalled();});

test('HTTP raster-ingest publication also rejects historical missing provenance',async()=>{
 repo.getById.mockResolvedValue({image_type:'ndvi',metadata:{downloadUrl:'https://invalid.test/display.zip'}});
 const r=await request(app).post('/api/v1/satellite/results/1/publish-raster');
 expect(r.status).toBe(409);expect(require('../raster-ingest.service').enqueue).not.toHaveBeenCalled();
});
test('HTTP raster-ingest preserves validated provenance and identifies display raster product',async()=>{
 const e=effectiveRequest(service.normalizeParams({...base,imageType:'ndvi',ndviMinThresh:.8}));
 repo.getById.mockResolvedValue({image_type:'ndvi',start_date:'2025-01-01',metadata:{downloadUrl:'https://invalid.test/display.zip',effectiveRequest:e,scientificSignature:scientificSignature(e)}});
 const ingest=require('../raster-ingest.service');ingest.enqueue.mockResolvedValue({job:{id:1,status:'pending'},deduplicated:false});
 const r=await request(app).post('/api/v1/satellite/results/1/publish-raster');expect(r.status).toBe(201);
 expect(ingest.enqueue.mock.calls[0][0].requestParams).toMatchObject({scientificSignature:scientificSignature(e),effectiveRequest:e,outputProduct:'visualized-rgb-tiff-zip'});
});
test('HTTP raster-ingest already-published historical layer remains idempotent',async()=>{repo.getById.mockResolvedValue({geoserver_layer:'kontum:existing'});const r=await request(app).post('/api/v1/satellite/results/1/publish-raster');expect(r.status).toBe(200);expect(r.body.data.alreadyPublished).toBe(true);});
