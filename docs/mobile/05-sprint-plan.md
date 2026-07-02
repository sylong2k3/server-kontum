# 05 — Kế hoạch Sprint & Rủi ro

Giả định: **2 dev Flutter**, sprint 2 tuần (~120h/sprint cho cả team), bắt đầu Sprint M1.

## 1. Lộ trình sprint

### Sprint M1 — Nền tảng + Auth (mục tiêu: đăng nhập được, khung app chạy)
- Toàn bộ M-EP-00 (MB-001 → MB-010).
- MB-020, MB-021, MB-025, MB-026 (auth lõi + guest).
- **Demo cuối sprint**: mở app → onboarding → đăng nhập/khách → shell 5 tab trống có theme.

### Sprint M2 — Bản đồ lõi (mục tiêu: xem được bản đồ rừng Kon Tum)
- MB-030 spike (làm ngay ngày 1–2), MB-031 → MB-036.
- MB-022, MB-023 (Google + đăng ký) song song bởi dev 2.
- **Demo**: bật/tắt lớp GeoServer, định vị GPS, tap xem thông tin đối tượng.

### Sprint M3 — Hiện trường offline-first (mục tiêu: gửi phản ánh + field-update kể cả mất mạng)
- MB-060 → MB-065 (feedback + outbox).
- MB-070 → MB-074 (field-update).
- **Demo**: airplane mode tạo phản ánh + field-update → bật mạng tự sync.

### Sprint M4 — Nội dung + Thông báo (mục tiêu: app "sống" hằng ngày)
- MB-050, MB-051, MB-053, MB-054 (tin tức/văn bản/PDF).
- MB-080 → MB-083 (FCM + màn thông báo).
- MB-024, MB-027, MB-038 (quên MK, hồ sơ, đo đạc) phần còn lại.
- **Demo**: nhận push thật, đọc tin offline, đo diện tích trên bản đồ.

### Sprint M5 — Role nâng cao + chất lượng (mục tiêu: đủ tính năng theo ma trận quyền)
- MB-066, MB-067 (xử lý phản ánh cán bộ), MB-090, MB-091 (thống kê UBND).
- MB-045, MB-046 (thời tiết), MB-037 (tìm đường), MB-040 (viễn thám), MB-084.
- MB-110 → MB-113 (test tổng hợp).
- **Demo**: đăng nhập 4 role thấy đúng chức năng theo bảng quyền.

### Sprint M6 — Release 1
- MB-114 → MB-118 (hardening, store).
- Buffer sửa bug UAT (~40h).
- Nếu server EP-06 kịp: kéo M-EP-09 (MB-100 → MB-103) vào đây hoặc thành Sprint M7.
- **Xuất xưởng**: Play internal testing + TestFlight → UAT với Sở NN&MT.

### Release 2 (sau UAT)
- M-EP-09 cảnh báo cháy (nếu chưa kịp), MB-039 offline tiles, MB-047 particle gió, MB-052 bình luận, MB-092 báo cáo UBND, feedback từ UAT.

## 2. Phụ thuộc server cần chốt trước từng sprint

| Trước sprint | Việc phía server (repo này) | Liên quan |
|---|---|---|
| M1 | Bổ sung tài khoản test 4 role trên staging; xác nhận CORS/rate-limit cho mobile | MB-021 |
| M2 | GeoServer staging truy cập được từ ngoài (HTTPS); chốt danh sách layer public trong `map.layers` | MB-032 |
| M2 | Chốt schema response `GET /map/layers` có đủ `type`, `url`, zoom range, legend URL (kiểm tra `map-layer.repository.js`) | MB-032 |
| M3 | Xác nhận `POST /feedback` chấp nhận `client_uuid` để dedupe (hiện validator feedback cần kiểm tra lại — nếu chưa có thì thêm, tương tự mobile validator) | MB-062 |
| M4 | Cấp `FCM_SERVICE_ACCOUNT` staging + endpoint test push; chốt payload push (title/body/data.deeplink) | MB-082 |
| M5 | Mở quyền `spatial.read` cho role ubnd_tinh nếu chưa seed | MB-091 |
| M6/R2 | **EP-06 fire-risk**: `/fire-risk/latest`, `/mobile/alerts/nearby`, `/fire-risk/subscribe` + job FIRMS | M-EP-09 |

## 3. Rủi ro chính & giảm thiểu

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| maplibre_gl lỗi trên thiết bị Android cũ / iOS mới | Cao | Spike MB-030 ngay đầu Sprint M2 với tiêu chí đo được; fallback flutter_map (raster-only vẫn đáp ứng nghiệp vụ WMS) |
| GPS sai số lớn dưới tán rừng → field-update lệch vị trí | Cao | Hiện accuracy realtime, chặn lưu khi >15m (cho phép override có ghi chú); trung bình hoá 5 mẫu GPS |
| Upload ảnh chậm ở vùng sóng yếu | TB | Nén mạnh, gửi tuần tự, cho phép gửi sau (outbox), không chặn UI |
| Server EP-06 trễ | TB | Đã tách M-EP-09; release 1 không chứa cảnh báo cháy |
| Duyệt App Store chậm (quyền vị trí nền, tài khoản demo) | TB | Không dùng background location ở release 1; chuẩn bị review notes + video demo từ Sprint M6 |
| Đổi schema API giữa chừng | TB | Freeze contract theo doc 03; thay đổi server phải cập nhật doc + báo team mobile |

## 4. Định nghĩa hoàn thành Release 1 (UAT checklist rút gọn)
1. 4 role đăng nhập thấy đúng chức năng theo ma trận doc 01 §2.
2. Guest xem bản đồ + gửi phản ánh không cần tài khoản.
3. Mất mạng: tạo phản ánh + field-update → có mạng tự đồng bộ, không bản ghi trùng.
4. Push notification tap mở đúng màn ở cả 3 trạng thái app, Android + iOS.
5. Bản đồ ≥25 FPS khi pan với 3 lớp bật trên máy Android 2GB RAM.
6. Không request nào chứa token trong log; token sống qua restart app; logout revoke sạch.
