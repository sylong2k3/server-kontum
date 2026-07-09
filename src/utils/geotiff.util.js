'use strict';

/**
 * geotiff.util.js
 * Xác thực nội dung file có thực sự là (Geo)TIFF hay không bằng magic-byte,
 * độc lập với phần mở rộng / MIME type do client khai (vốn có thể giả mạo).
 *
 * TIFF header (4 byte đầu):
 *   49 49 2A 00  → "II*\0"  little-endian TIFF
 *   4D 4D 00 2A  → "MM\0*"  big-endian    TIFF
 *   49 49 2B 00  → little-endian BigTIFF
 *   4D 4D 00 2B  → big-endian    BigTIFF
 * GeoTIFF là TIFF hợp lệ nên cùng magic-byte này.
 */

const TIFF_MAGICS = [
    Buffer.from([0x49, 0x49, 0x2a, 0x00]),
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a]),
    Buffer.from([0x49, 0x49, 0x2b, 0x00]),
    Buffer.from([0x4d, 0x4d, 0x00, 0x2b]),
];

/** Số byte tối thiểu cần đọc để kiểm tra. */
const TIFF_MAGIC_LENGTH = 4;

/**
 * @param {Buffer} buf — chứa ít nhất 4 byte đầu của file.
 * @returns {boolean}
 */
const isTiffBuffer = (buf) => {
    if (!Buffer.isBuffer(buf) || buf.length < TIFF_MAGIC_LENGTH) { return false; }
    const head = buf.subarray(0, TIFF_MAGIC_LENGTH);
    return TIFF_MAGICS.some((magic) => head.equals(magic));
};

module.exports = { isTiffBuffer, TIFF_MAGIC_LENGTH };
