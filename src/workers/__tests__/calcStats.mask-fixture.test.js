'use strict';
// Minimal uncompressed TIFF 6.0 fixture: independent byte layout, not the reader's writer.
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const zlib = require('zlib');
let dir;
function makeTiff(file, { mask = [1, 1, 1, 0], maskWidth = 2, extraMask = false, bitMask = false } = {}) {
    const entries = (offset, width, height, subfile, values, next) => {
        const tags = [[254,4,1,subfile],[256,4,1,width],[257,4,1,height],[258,3,1,subfile && bitMask ? 1 : 8],
            [259,3,1,1],[262,3,1,subfile ? 4 : 1],[273,4,1,offset+138],[277,3,1,1],
            [278,4,1,height],[279,4,1,values.length],[284,3,1,1]];
        const buf = Buffer.alloc(138 + values.length); buf.writeUInt16LE(tags.length,0);
        tags.forEach(([tag,type,count,value],i)=>{const at=2+i*12;buf.writeUInt16LE(tag,at);buf.writeUInt16LE(type,at+2);buf.writeUInt32LE(count,at+4);buf.writeUInt32LE(value,at+8);});
        buf.writeUInt32LE(next,2+tags.length*12); Buffer.from(values).copy(buf,138); return buf;
    };
    const firstOffset=8, maskOffset=150, secondMaskOffset=292;
    const header=Buffer.from([0x49,0x49,42,0,8,0,0,0]);
    const data=entries(firstOffset,2,2,0,[0,10,20,250],maskOffset);
    const packedMask = bitMask ? [((mask[0] << 1) | mask[1]) << 6, ((mask[2] << 1) | mask[3]) << 6] : mask;
    const validity=entries(maskOffset,maskWidth,2,4,packedMask,extraMask?secondMaskOffset:0);
    fs.writeFileSync(file,Buffer.concat([header,data,validity,...(extraMask?[entries(secondMaskOffset,2,2,4,[1,1,1,1],0)]:[])]));
}
function makeBigTiff(file, values = [10, 20, 30, 40]) {
    const header = Buffer.alloc(16);
    header.write('II', 0);
    header.writeUInt16LE(43, 2);
    header.writeUInt16LE(8, 4);
    header.writeUInt16LE(0, 6);
    header.writeBigUInt64LE(16n, 8);
    const tags = [
        [256, 4, 1n, 2n], [257, 4, 1n, 2n], [258, 3, 1n, 8n], [259, 3, 1n, 1n],
        [262, 3, 1n, 1n], [273, 16, 1n, 0n], [277, 3, 1n, 1n], [278, 4, 1n, 2n],
        [279, 16, 1n, BigInt(values.length)], [284, 3, 1n, 1n],
    ];
    const ifdSize = 8 + tags.length * 20 + 8;
    tags[5][3] = BigInt(16 + ifdSize);
    const ifdBuf = Buffer.alloc(ifdSize);
    ifdBuf.writeBigUInt64LE(BigInt(tags.length), 0);
    tags.forEach(([tag, type, count, val], i) => {
        const at = 8 + i * 20;
        ifdBuf.writeUInt16LE(tag, at);
        ifdBuf.writeUInt16LE(type, at + 2);
        ifdBuf.writeBigUInt64LE(count, at + 4);
        ifdBuf.writeBigUInt64LE(val, at + 12);
    });
    ifdBuf.writeBigUInt64LE(0n, 8 + tags.length * 20);
    fs.writeFileSync(file, Buffer.concat([header, ifdBuf, Buffer.from(values)]));
}
function makeDeflateTiff(file, values = [10, 20, 30, 40]) {
    const compressed = zlib.deflateSync(Buffer.from(values));
    const tags = [
        [256, 4, 1, 2], [257, 4, 1, 2], [258, 3, 1, 8], [259, 3, 1, 8],
        [262, 3, 1, 1], [273, 4, 1, 8 + 126], [277, 3, 1, 1], [278, 4, 1, 2],
        [279, 4, 1, compressed.length], [284, 3, 1, 1],
    ];
    const ifdBuf = Buffer.alloc(126 + compressed.length);
    ifdBuf.writeUInt16LE(tags.length, 0);
    tags.forEach(([tag, type, count, val], i) => {
        const at = 2 + i * 12;
        ifdBuf.writeUInt16LE(tag, at);
        ifdBuf.writeUInt16LE(type, at + 2);
        ifdBuf.writeUInt32LE(count, at + 4);
        ifdBuf.writeUInt32LE(val, at + 8);
    });
    ifdBuf.writeUInt32LE(0, 2 + tags.length * 12);
    compressed.copy(ifdBuf, 126);
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]), ifdBuf]));
}
function read(filePath){return new Promise((resolve,reject)=>{const w=new Worker(path.resolve(__dirname,'../calcStats.thread.js'),{workerData:{filePath}});w.once('message',resolve);w.once('error',reject);});}
beforeAll(()=>{dir=fs.mkdtempSync(path.join(__dirname,'v4-mask-fixture-'));});
afterAll(()=>fs.rmSync(dir,{recursive:true,force:true}));
test('actual chained internal-mask TIFF excludes masked outlier and retains valid zero across all aggregates',async()=>{
    const p=path.join(dir,'mask.tif');makeTiff(p);const r=await read(p);expect(r.error).toBeUndefined();
    const b=r.stats[0];expect(b).toMatchObject({min:0,max:20,mean:10,valid_pixels:3,total_pixels:4});
    expect(b.std).toBe(Number(Math.sqrt(200/3).toFixed(4)));expect(b.histogram.counts.reduce((a,v)=>a+v,0)).toBe(3);
});
test('actual all-masked TIFF is missing statistics, not zero',async()=>{
    const p=path.join(dir,'all-mask.tif');makeTiff(p,{mask:[0,0,0,0]});
    expect((await read(p)).stats[0]).toMatchObject({mean:null,std:null,min:null,max:null,valid_pixels:0});
});
test('actual one-bit TIFF transparency mask uses packed scanlines and independent oracle',async()=>{
    const p=path.join(dir,'bit-mask.tif');makeTiff(p,{bitMask:true});const r=await read(p);
    expect(r.error).toBeUndefined();expect(r.stats[0]).toMatchObject({min:0,max:20,mean:10,valid_pixels:3,total_pixels:4});
    expect(r.stats[0].histogram.counts.reduce((a,v)=>a+v,0)).toBe(3);
});
test.each([['wrong-grid',{maskWidth:1,mask:[1,1]}],['ambiguous',{extraMask:true}]])('actual %s internal mask fails explicitly',async(name,options)=>{
    const p=path.join(dir,name+'.tif');makeTiff(p,options);const r=await read(p);
    expect(r.code).toBe('RASTER_VALIDITY_UNSUPPORTED');expect(r.stats).toBeUndefined();
});
test('actual BigTIFF fixture with 64-bit offsets calculates identical statistics without 4GB allocation', async () => {
    const p = path.join(dir, 'bigtiff.tif');
    makeBigTiff(p, [10, 20, 30, 40]);
    const r = await read(p);
    expect(r.error).toBeUndefined();
    expect(r.stats[0]).toMatchObject({ min: 10, max: 40, mean: 25, std: 11.1803, valid_pixels: 4, total_pixels: 4 });
});
test('actual Deflate compressed TIFF decompresses and calculates identical statistics', async () => {
    const p = path.join(dir, 'deflate.tif');
    makeDeflateTiff(p, [10, 20, 30, 40]);
    const r = await read(p);
    expect(r.error).toBeUndefined();
    expect(r.stats[0]).toMatchObject({ min: 10, max: 40, mean: 25, std: 11.1803, valid_pixels: 4, total_pixels: 4 });
});
test('remote sidecar .msk presence fails explicitly rather than ignoring external mask', async () => {
    const p = path.join(dir, 'sidecar-test.tif');
    makeTiff(p);
    fs.writeFileSync(`${p}.msk`, Buffer.from([1, 2, 3]));
    const r = await read(p);
    expect(r.code).toBe('RASTER_VALIDITY_UNSUPPORTED');
    expect(r.stats).toBeUndefined();
});
