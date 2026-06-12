# 10 — Traceability Matrix (Ma trận truy vết yêu cầu)

> Ánh xạ từng nhóm chức năng trong tài liệu gốc *"Danh mục chức năng WebGIS-MobileGIS Kon Tum"* sang Epic/Story để kiểm tra độ phủ. Cột vai trò ghi quyền cao nhất; chi tiết phân quyền theo `auth.roles.permissions`.

## 1. Ánh xạ nhóm chức năng → Backlog

| Nhóm chức năng (tài liệu gốc) | Epic | Story | Ghi chú |
|-------------------------------|------|-------|---------|
| Đăng nhập / Đăng ký | EP-01 | US-001..007 | ✅ đã hiện thực |
| Quản trị người dùng | EP-02 | US-010..013 | Soft delete, RBAC |
| Quản trị ảnh vệ tinh | EP-04 | US-030, US-034 | Quản lý + phân loại |
| Quản trị lớp dữ liệu bản đồ | EP-03 | US-020, US-021 | Import shapefile/excel |
| API dữ liệu bản đồ | EP-03 | US-025 | api_key + scope |
| Quản trị tin tức | EP-08 | US-070, US-071 | CMS news + comment |
| Quản trị báo cáo – văn bản | EP-08 | US-072 | cms.documents |
| Quản trị bản đồ PDF | EP-08 | US-073 | pdf_map |
| Thông tin cập nhật từ MobileGIS | EP-09, EP-10 | US-080..083, US-091..092 | field updates + xác minh |
| Tương tác bản đồ WebGIS | EP-03 | US-022, US-023, US-026 | 3D, lớp nền, popup |
| Tương tác dữ liệu thời tiết | EP-05 | US-040..042 | nhiệt/mưa/gió |
| Tương tác ảnh vệ tinh | EP-04 | US-031..033 | so sánh, tính diện tích, xuất vector |
| Thống kê | EP-07 | US-060, US-063 | theo huyện/thời gian, dashboard |
| Phân tích không gian | EP-07 | US-061, US-062 | thay đổi rừng, khoảng cách dân cư–rừng |
| Dự báo cháy rừng | EP-06 | US-050..056 | core module |
| Tin tức | EP-08 | US-070, US-071 | đọc/đăng/bình luận |
| Báo cáo | EP-08, EP-07 | US-072, US-063 | xem báo cáo điều hành |
| Gửi phản ánh | EP-09 | US-080..083 | kèm ảnh vi phạm |
| MobileGIS – tương tác bản đồ | EP-10 | US-090, US-094 | GPS, tìm đường |
| MobileGIS – giám sát hiện trạng | EP-10, EP-09 | US-091, US-092 | chụp ảnh, cập nhật |
| MobileGIS – tin tức / văn bản | EP-08, EP-10 | US-070, US-072 | đọc, tra cứu |

**Kết luận độ phủ:** tất cả 21 nhóm chức năng trong tài liệu gốc đều có Epic/Story tương ứng. ✅

## 2. Ánh xạ phần "Xử lý cháy rừng" (tài liệu §1–§12) → thiết kế

| Mục tài liệu cháy rừng | Tài liệu thiết kế |
|------------------------|-------------------|
| §1 Nguồn dữ liệu | `07-fire-risk-design.md` §2–3; `04` pipeline |
| §2 Chỉ số GEE | `07` §3 |
| §3 Phân cấp nguy cơ | `07` §3–4 |
| §4 Xử lý trên GEE | `07` §6 |
| §5 Tích hợp FIRMS | `07` §7 |
| §6 Lưu PostGIS | `05` §5 (`fire.*`) |
| §7–8 Hiển thị WebGIS/Mapbox | `07` §10; `06` §7 |
| §9 Cảnh báo MobileGIS | `09-mobilegis-design.md` §6 |
| §10 Kiến trúc xử lý | `04` §4; `07` §5 |
| §11 Lịch cập nhật | `07` §11 (cron `.env`) |
| §12 Hai lớp cảnh báo | `07` §2 |

## 3. Ánh xạ vai trò → quyền chính

| Chức năng | system_admin | ubnd_tinh | so_nnmt | citizen |
|-----------|:---:|:---:|:---:|:---:|
| Quản trị user | CRUD | xem | cấp sở | hồ sơ |
| Lớp dữ liệu | CRUD/import | xem | quản lý rừng/MT | xem public |
| API bản đồ | tạo/cấp | dùng | khai thác | — |
| Ảnh vệ tinh | toàn quyền | xem/so sánh | phân loại/diện tích | public |
| Thời tiết | quản trị nguồn | theo dõi | cảnh báo | xem |
| Dự báo cháy | cấu hình | cảnh báo tỉnh | theo dõi chỉ số | cảnh báo public |
| Phân tích KG | mô hình | xem cảnh báo | phân tích | — |
| Thống kê | cấu hình | biểu đồ điều hành | theo huyện | public |
| Tin tức | quản lý | đọc | đăng chuyên môn | đọc/bình luận |
| Phản ánh | tiếp nhận | theo dõi tỉnh | xử lý rừng | gửi |
| MobileGIS | quản trị app | theo dõi | đo đạc/cập nhật | xem/GPS |

## 4. Khoảng trống & câu hỏi mở (cần PO làm rõ)
1. Ranh giới rừng/tiểu khu lấy từ đâu, định dạng nào (shapefile/GeoJSON), tần suất cập nhật?
2. Có cần phân quyền theo địa bàn (huyện) cho tài khoản sở không?
3. Mô hình trọng số FireRisk: dùng bộ trọng số nào chính thức (tài liệu nêu 2 biến thể)?
4. MobileGIS: React Native hay Flutter? Có yêu cầu offline map tiles không?
5. Bình luận tin tức: kiểm duyệt trước hay sau đăng?
6. ~~Lưu trữ ảnh phản ánh: filesystem local hay object storage (S3/MinIO)?~~ → **ĐÃ CHỐT: lưu local filesystem** (`public/uploads/...` qua `upload.middleware.js`, phục vụ tại `/uploads`). Xem doc 14 §J.
7. SLA cảnh báo cháy: độ trễ tối đa chấp nhận từ FIRMS tới push?
