'use strict';

/**
 * Optimistic Locking dùng chung cho mọi repository.
 *
 * Theo docs/architecture/05-database-design.md §6.1: hệ thống KHÔNG tạo cột
 * `version` riêng — dùng chính `updated_at` làm version của bản ghi. Client giữ
 * `updatedAt` nhận từ API detail và gửi lại qua `expectedUpdatedAt` khi cập nhật.
 *
 * ⚠️ Lưu ý precision: PostgreSQL lưu timestamptz ở microsecond
 * (vd `2026-06-26 10:00:00.246350+00`), nhưng pg driver trả về JS Date chỉ giữ
 * millisecond (`.246`). Khi client echo lại giá trị đó, so sánh thẳng
 * `updated_at = $N::timestamptz` sẽ KHÔNG khớp (`246350µs ≠ 246000µs`) → luôn
 * 0 rows → 409 oan. Vì vậy phải `date_trunc('milliseconds', ...)` cả hai vế.
 */

/**
 * Tạo mảnh SQL điều kiện version để chèn vào WHERE của câu UPDATE.
 *
 * Cách dùng trong repository:
 *   let lockSql = '';
 *   if (payload.expectedUpdatedAt) {
 *       params.push(payload.expectedUpdatedAt);
 *       lockSql = versionCondition(params.length);
 *   }
 *   `UPDATE ... WHERE id = $1 AND deleted_at IS NULL${lockSql} RETURNING *`
 *
 * @param {number} paramIndex - vị trí $N của tham số expectedUpdatedAt trong mảng params
 * @param {string} [column='updated_at'] - tên cột version
 * @returns {string} SQL fragment bắt đầu bằng ' AND ...'
 */
const versionCondition = (paramIndex, column = 'updated_at') =>
    ` AND date_trunc('milliseconds', ${column}) = date_trunc('milliseconds', $${paramIndex}::timestamptz)`;

module.exports = { versionCondition };
