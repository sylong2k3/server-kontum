'use strict';
jest.mock('../../configs/gge',()=>({ee:{}}));
jest.mock('../../utils/gee-satellite.util',()=>({eeEval:jest.fn()}));
jest.mock('../../services/minio.service',()=>({uploadFile:jest.fn()}));
jest.mock('../../utils/geoserver.client',()=>({harvestGeoTiff:jest.fn()}));
jest.mock('fs/promises',()=>({unlink:jest.fn(async()=>{})}));
const mockDownload=jest.fn();
jest.mock('@google-cloud/storage',()=>({Storage:jest.fn(()=>({bucket:()=>({file:()=>({download:mockDownload})})}))}),{virtual:true});
const minio=require('../../services/minio.service');
const gs=require('../geoserver.client');
const fs=require('fs/promises');
const {publishRasterToMinio}=require('../gee-export.helper');
const args={bucket:'mock-bucket',gcsPath:'scientific',fileName:'fixture.tif',minioKey:'key.tif',minioBucket:'rasters',storeName:'coverage',harvest:false};
beforeEach(()=>{jest.clearAllMocks();mockDownload.mockResolvedValue();minio.uploadFile.mockResolvedValue();});
test.each(['download','minio'])('F23 transport %s failure propagates and cleans local artifact',async step=>{
 if(step==='download')mockDownload.mockRejectedValueOnce(new Error(step));else minio.uploadFile.mockRejectedValueOnce(new Error(step));
 await expect(publishRasterToMinio(args)).rejects.toThrow(step);expect(fs.unlink).toHaveBeenCalled();expect(gs.harvestGeoTiff).not.toHaveBeenCalled();
});
test('MinIO-only success does not invent GeoServer layer; TIFF bytes are not transformed',async()=>{
 const p=await publishRasterToMinio(args);expect(p).toMatchObject({minioKey:'key.tif',geoserverLayer:null});
 expect(minio.uploadFile).toHaveBeenCalledWith('rasters','key.tif',expect.stringContaining('fixture.tif'),'image/tiff');expect(fs.unlink).toHaveBeenCalled();
});
