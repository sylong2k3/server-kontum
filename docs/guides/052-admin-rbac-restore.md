# Triển khai migration 052 — khôi phục quyền Admin

## Trạng thái

Migration đã chuẩn bị trong repository, **chưa chạy trên DB nào**. Không có PostgreSQL/Docker cục bộ để kiểm thử SQL độc lập trong lượt triển khai này. Test middleware HTTP không thay thế kiểm thử migration SQL.

Không chạy `npm run migrate` trực tiếp trên production khi chưa kiểm tra lịch sử: các migration 046–048 có thao tác xóa dữ liệu.

## Điều kiện trước triển khai

1. Xác minh domain API → reverse proxy → service/PID → cwd → commit → DB đang phục vụ domain.
2. Trên đúng DB, dùng truy vấn chỉ đọc để kiểm tra:

```sql
SELECT current_database(), current_user, inet_server_addr(), inet_server_port();
SELECT filename, executed_at FROM core.schema_migrations ORDER BY filename;
SELECT code, permissions, updated_at FROM auth.roles
WHERE code IN ('system_admin', 'ubnd_tinh', 'so_nnmt', 'citizen') ORDER BY code;
```

3. Lưu kết quả permissions ra bản sao an toàn ngoài DB. Không ghi credential/token vào báo cáo.
4. Đối chiếu toàn bộ migration trước 052. Dừng nếu có migration cũ chưa chạy; review riêng, không replay chúng để sửa quyền.
5. Review explicit `false`: migration bảo toàn các giá trị đã tồn tại, kể cả từ chối rõ ràng. Quyền bị `false` sẽ không được tự bật.
6. Xác nhận policy đã thu hồi vẫn đúng: Sở không `remote_sensing.create`/`map_layers.publish`; UBND không `fire_risk.manage`/`forest_classification.manage`.
7. Clone/sanitise DB sang môi trường thử nghiệm độc lập; chạy migration ở đó trước production.

## Cách merge

- Chỉ bổ sung action thiếu trong các nhóm của migration 006, 009/010, 013 PDF, 015, 017/025, 028, 031, 032/033.
- Giá trị action hiện có và resource tùy chỉnh được giữ nguyên.
- Hai thu hồi của 024 và read-only của UBND trong 049 ưu tiên cao hơn quyền tùy chỉnh xung đột.
- Citizen, quyền CMS/người dùng/API không được mở rộng.
- Lock role, kiểm tra object JSONB và lưu snapshot `core.rbac_restore_052_snapshot` trước update.
- Runner hiện có cung cấp transaction; SQL không tự COMMIT.

## Kiểm thử SQL trên môi trường độc lập

- DB có quyền thiếu: dashboard UBND/Sở, feedback, field_measurements, ground_truth Sở được bổ sung.
- Action `false` không đổi thành `true`; resource/action tùy chỉnh không mất.
- Sở không có hai action bị thu hồi; UBND không có manage rừng/cháy.
- Citizen không thay đổi.
- Chạy file lần hai: permissions không đổi và snapshot ban đầu không bị ghi đè.
- JSONB malformed/mất một trong ba role: transaction fail, không có thay đổi một phần.
- Snapshot/rollback phục hồi đúng permissions trước migration.

## Kiểm tra sau triển khai

```sql
SELECT code, permissions FROM auth.roles
WHERE code IN ('system_admin', 'ubnd_tinh', 'so_nnmt') ORDER BY code;
SELECT role_code, captured_at FROM core.rbac_restore_052_snapshot ORDER BY role_code;
```

Đăng nhập/reload từng role để nạp lại `/auth/me`. Lặp ma trận API của plan đã duyệt. Kiểm tra UBND/Sở dashboard 200 nếu không có explicit denial; UBND history vẫn 403 khi chủ động thử trực tiếp; UI không tự gọi history. Kiểm tra citizen vẫn không vào Admin.

Không thử CRUD/pipeline trên dữ liệu production để nghiệm thu; dùng record và môi trường test riêng.

## Rollback có kiểm soát

Trong cửa sổ bảo trì, review permissions hiện tại với snapshot; nếu có thay đổi quyền mới sau 052, không ghi đè chúng bằng rollback toàn bộ.

```sql
BEGIN;
SELECT code FROM auth.roles
WHERE code IN ('system_admin', 'ubnd_tinh', 'so_nnmt') FOR UPDATE;
-- Chỉ chạy sau khi review và chấp nhận phục hồi snapshot đầy đủ:
UPDATE auth.roles AS r
SET permissions = s.permissions
FROM core.rbac_restore_052_snapshot AS s
WHERE r.code = s.role_code;
-- Không xóa snapshot. Chỉ bỏ bản ghi 052 nếu có quyết định chạy lại migration:
-- DELETE FROM core.schema_migrations
-- WHERE filename = '052_restore_missing_admin_permissions.sql';
COMMIT;
```

Sau rollback, reload `/auth/me` và xác minh API. Không chỉnh JWT/middleware để bù quyền DB.

## Origin local

Dùng `http://localhost:5174`. API hiện cho origin này nhưng chặn `http://127.0.0.1:5174`. Nếu cần 127, chỉ bổ sung origin đầy đủ vào allowlist của đúng service backend, restart đúng process và kiểm tra OPTIONS/actual request. Không dùng wildcard hay nới CSP.
