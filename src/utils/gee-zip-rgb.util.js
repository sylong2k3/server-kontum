'use strict';

/**
 * Xử lý zip trả về bởi GEE `image.visualize(...).getDownloadURL({fileFormat:'GeoTIFF'})`
 * → GeoTIFF RGB 3 band, đóng gói COG (Cloud-Optimized).
 *
 * GEE zip điển hình có các file:
 *   <name>.vis-red.tif
 *   <name>.vis-green.tif
 *   <name>.vis-blue.tif
 * Hoặc 1 file duy nhất khi image đã stack sẵn.
 *
 * Yêu cầu binary hệ thống (đã bắt buộc bởi ogr.util):
 *   - `tar` (Windows 10+/Linux/macOS đều có sẵn) — giải nén
 *   - `gdalbuildvrt` + `gdal_translate` — build VRT + xuất COG
 */

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

const DEBUG = process.env.RASTER_INGEST_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';

const dbg = (msg) => { if (DEBUG) console.debug(`[GEE-ZIP] ${msg}`); };

// Wrap execFile để log lệnh + thời gian (đầu vào có thể chứa path nội bộ, không có secret).
async function _runCmd(bin, args, opts = {}) {
    const t0 = Date.now();
    dbg(`exec ${bin} ${args.map((a) => (a.length > 80 ? a.slice(0, 80) + '…' : a)).join(' ')}`);
    try {
        const { stdout, stderr } = await execFileP(bin, args, opts);
        dbg(`ok ${bin} (${Date.now() - t0}ms)`);
        if (stderr && DEBUG) {
            const trimmed = stderr.trim().slice(0, 300);
            if (trimmed) console.debug(`[GEE-ZIP] ${bin} stderr: ${trimmed}`);
        }
        return { stdout, stderr };
    } catch (err) {
        // stderr là thông tin quý nhất khi debug GDAL failure — luôn log warn.
        const err_stderr = (err.stderr || '').trim().slice(0, 500);
        console.warn(`[GEE-ZIP] ${bin} FAIL (${Date.now() - t0}ms) code=${err.code} stderr=${err_stderr || '(none)'}`);
        throw err;
    }
}

class GeoTiffProcessError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'GeoTiffProcessError';
        this.code = code;
    }
}

const RGB_ORDER = ['red', 'green', 'blue'];

async function safeMkdir(dir)  { await fs.promises.mkdir(dir, { recursive: true }); }
async function safeRmdir(dir) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Đọc 4 byte đầu → phân biệt zip vs TIFF trần vs khác.
 * GEE `getDownloadURL({filePerBand:false})` trên `.visualize()` output có thể
 * trả về TIFF trần (Content-Type image/tiff) thay vì zip — phải handle cả 2.
 *   zip:  PK\x03\x04 = 50 4B 03 04
 *   TIFF little-endian: II*\0 = 49 49 2A 00
 *   TIFF big-endian:    MM\0* = 4D 4D 00 2A
 */
async function detectFileKind(filePath) {
    const fd = await fs.promises.open(filePath, 'r');
    try {
        const buf = Buffer.alloc(4);
        await fd.read(buf, 0, 4, 0);
        if (buf[0] === 0x50 && buf[1] === 0x4B) return 'zip';
        if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) ||
            (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A)) {
            return 'tiff';
        }
        return 'unknown';
    } finally {
        await fd.close();
    }
}

/**
 * Giải nén zip vào `outDir` bằng `tar -xf` — cross-platform.
 * Node.js ≥ 18 có bsdtar trên Windows và GNU tar/bsdtar trên Unix; cả 2
 * đều đọc .zip qua `tar -xf`.
 */
async function extractZip(zipPath, outDir) {
    await safeMkdir(outDir);
    try {
        const stat = await fs.promises.stat(zipPath);
        dbg(`unzip src=${zipPath} size=${(stat.size / 1048576).toFixed(2)}MB → ${outDir}`);
        await _runCmd('tar', ['-xf', zipPath, '-C', outDir]);
    } catch (err) {
        throw new GeoTiffProcessError(
            `Giải nén zip thất bại: ${err.message}`,
            'UNZIP_FAILED',
        );
    }
}

/**
 * Tìm các file .tif trong `dir`, phân loại theo tên band nếu có
 * (`.vis-red.`, `.vis-green.`, `.vis-blue.`). Không cần phân biệt case.
 */
async function classifyTifs(dir) {
    const entries = await fs.promises.readdir(dir);
    const tifs = entries.filter((f) => /\.tif{1,2}$/i.test(f));
    if (!tifs.length) {
        throw new GeoTiffProcessError(
            'Zip không chứa .tif nào — GEE response không hợp lệ',
            'NO_TIF_IN_ZIP',
        );
    }

    const byBand = { red: null, green: null, blue: null, others: [] };
    for (const name of tifs) {
        const lower = name.toLowerCase();
        if      (lower.includes('vis-red')   || lower.includes('.red.'))   byBand.red   = name;
        else if (lower.includes('vis-green') || lower.includes('.green.')) byBand.green = name;
        else if (lower.includes('vis-blue')  || lower.includes('.blue.'))  byBand.blue  = name;
        else byBand.others.push(name);
    }
    return { tifs, byBand };
}

/**
 * Tạo COG RGB tại `outCog` từ zip GEE.
 *   1. tar -xf → extractDir
 *   2. Nếu có đủ 3 band vis-*: gdalbuildvrt -separate red green blue → stack.vrt
 *      Ngược lại nếu 1 file: gdalbuildvrt trực tiếp → COG (giữ nguyên band)
 *   3. gdal_translate stack.vrt outCog -of COG -co COMPRESS=DEFLATE -co ...
 */
async function processGeeZipToCog(zipPath, outCog, { gdalCacheMB = 512 } = {}) {
    const workDir  = path.join(path.dirname(outCog), `unzip_${path.basename(outCog, '.tif')}`);
    const vrtPath  = path.join(workDir, 'stack.vrt');
    // GDAL đọc GDAL_CACHEMAX từ env — set inline cho subprocess.
    const gdalEnv  = { ...process.env, GDAL_CACHEMAX: String(gdalCacheMB) };

    try {
        // GEE với .visualize() + filePerBand:false thường trả TIFF trần, không zip.
        // Phân biệt bằng magic bytes trước khi tar để tránh "Unrecognized archive format".
        const kind = await detectFileKind(zipPath);
        dbg(`detected kind=${kind} for ${zipPath}`);

        // ── TIFF trần: GDAL-free fast-path ──────────────────────────────
        // GEE .visualize() đã stack 3-band RGB uint8 sẵn — không cần merge
        // hay xây COG. Copy thẳng file làm output. Trade-off: mất internal
        // overview / tiled layout (COG features). Với ảnh cỡ chục KB → vài MB
        // ở scale 500m, không ảnh hưởng hiệu năng render đáng kể.
        if (kind === 'tiff') {
            await safeMkdir(path.dirname(outCog));
            await fs.promises.copyFile(zipPath, outCog);
            const stat = await fs.promises.stat(outCog);
            dbg(`tiff passthrough size=${(stat.size / 1048576).toFixed(2)}MB path=${outCog}`);
            return { path: outCog, size: stat.size, mode: 'tiff_passthrough' };
        }

        if (kind !== 'zip') {
            throw new GeoTiffProcessError(
                `File tải từ GEE không phải zip cũng không phải TIFF (magic=${kind}). Kiểm tra URL còn hạn không.`,
                'UNKNOWN_FORMAT',
            );
        }

        // ── ZIP branch (GEE trả bundle 3 file .vis-red/green/blue) ──────
        // Vẫn cần GDAL để merge RGB → COG. Nếu server chưa cài GDAL, path
        // này sẽ throw GDAL_FAILED (spawn ENOENT) — tuỳ deploy quyết định
        // cài OSGeo4W hay đổi getDownloadURL để luôn trả TIFF trần.
        await extractZip(zipPath, workDir);
        const { tifs, byBand } = await classifyTifs(workDir);

        const hasRgbBands = byBand.red && byBand.green && byBand.blue;
        dbg(`classified tifs=${tifs.length} mode=${hasRgbBands ? 'rgb_merge' : 'passthrough'} `
            + (hasRgbBands
                ? `R=${byBand.red} G=${byBand.green} B=${byBand.blue}`
                : `first=${tifs[0]} others=${byBand.others.length}`));

        let vrtInputs;
        if (hasRgbBands) {
            vrtInputs = RGB_ORDER.map((band) => path.join(workDir, byBand[band]));
            await _runCmd('gdalbuildvrt', ['-separate', vrtPath, ...vrtInputs], { env: gdalEnv });
        } else {
            const first = tifs.find((t) => !/aux\.xml$/i.test(t));
            vrtInputs = [path.join(workDir, first)];
            await _runCmd('gdalbuildvrt', [vrtPath, ...vrtInputs], { env: gdalEnv });
        }

        // Convert VRT → COG. -of COG tự sinh overview + tiled + compress.
        await _runCmd('gdal_translate', [
            vrtPath, outCog,
            '-of', 'COG',
            '-co', 'COMPRESS=DEFLATE',
            '-co', 'PREDICTOR=2',
            '-co', 'NUM_THREADS=ALL_CPUS',
            '-co', 'BIGTIFF=IF_SAFER',
        ], { env: gdalEnv });

        const stat = await fs.promises.stat(outCog);
        dbg(`COG done size=${(stat.size / 1048576).toFixed(2)}MB path=${outCog}`);
        return { path: outCog, size: stat.size, mode: hasRgbBands ? 'rgb_merge' : 'passthrough' };
    } catch (err) {
        if (err instanceof GeoTiffProcessError) throw err;
        // ENOENT = GDAL binary chưa cài trên PATH. Nêu rõ để ops biết fix nhanh.
        if (err.code === 'ENOENT') {
            throw new GeoTiffProcessError(
                `GDAL không có trên PATH (spawn ENOENT). Cài OSGeo4W hoặc dùng flow TIFF (getDownloadURL filePerBand:false).`,
                'GDAL_NOT_INSTALLED',
            );
        }
        throw new GeoTiffProcessError(
            `GDAL xử lý zip thất bại: ${err.stderr || err.message}`,
            'GDAL_FAILED',
        );
    } finally {
        await safeRmdir(workDir);
        dbg(`workdir removed ${workDir}`);
    }
}

module.exports = { processGeeZipToCog, extractZip, classifyTifs, detectFileKind, GeoTiffProcessError };
