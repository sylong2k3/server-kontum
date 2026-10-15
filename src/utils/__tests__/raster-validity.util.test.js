'use strict';
const { rasterValidity } = require('../raster-validity.util');
function image({tags={},noData=null,metadata=null,width=2,height=2,bands=1,mask=[1,0,1,0]}={}) {
    return {getFileDirectory:()=>({hasTag:n=>Object.hasOwn(tags,n),getValue:n=>tags[n]}),getGDALNoData:()=>noData,
        getGDALMetadata:async sample=>sample==null?null:metadata,getSamplesPerPixel:()=>bands,
        getWidth:()=>width,getHeight:()=>height,readRasters:async()=>[mask]};
}
const tiff = images => ({getImageCount:async()=>images.length,getImage:async i=>images[i]});
describe('F24 raster validity policy',()=>{
    test('multiband scalar NoData applies equally, valid zero retained',async()=>{
        const im=image({noData:255,bands:2});const policy=await rasterValidity(tiff([im]),im,'not-a-real-fixture');
        for(const b of [0,1]) { expect(policy(b)(0,0)).toBe(true);expect(policy(b)(255,0)).toBe(false);expect(policy(b)(Infinity,0)).toBe(false); }
    });
    test('full-resolution chained internal mask excludes invalid cells',async()=>{
        const im=image();const m=image({tags:{NewSubfileType:4}});const policy=await rasterValidity(tiff([im,m]),im,'fixture');
        expect(policy(0)(10,0)).toBe(true);expect(policy(0)(10,1)).toBe(false);
    });
    test.each([{SubIFDs:[100]},{ExtraSamples:[2]}])('unsupported mask %j fails explicitly',async tags=>{
        const im=image({tags});await expect(rasterValidity(tiff([im]),im,'fixture')).rejects.toMatchObject({code:'RASTER_VALIDITY_UNSUPPORTED'});
    });
    test('per-band metadata is not silently ignored',async()=>{
        const im=image({metadata:{NODATA_VALUE:'-9999'}});await expect(rasterValidity(tiff([im]),im,'fixture')).rejects.toMatchObject({code:'RASTER_VALIDITY_UNSUPPORTED'});
    });
    test('incompatible mask grid fails',async()=>{
        const im=image(), m=image({tags:{NewSubfileType:4},width:1});await expect(rasterValidity(tiff([im,m]),im,'fixture')).rejects.toMatchObject({code:'RASTER_VALIDITY_UNSUPPORTED'});
    });
});
