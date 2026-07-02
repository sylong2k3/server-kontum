# 04 — Backlog chi tiết: Epic → Task

Quy ước:
- **Ước lượng**: giờ công (h) cho 1 dev Flutter mid-level. 1 ngày ≈ 6h hiệu dụng.
- **Ưu tiên**: P0 bắt buộc release 1, P1 release 1 nếu kịp, P2 release 2.
- **DoD chung mọi task**: code qua `flutter analyze` sạch, có widget/unit test cho logic chính, chạy được trên Android + iOS, UI có đủ 4 trạng thái (loading/empty/error/data) nếu là màn hình.

---

## M-EP-00 — Khởi tạo dự án & nền tảng (foundation)

| ID | Task | Chi tiết công việc | Ưu tiên | Ước lượng | Phụ thuộc |
|---|---|---|---|---|---|
| MB-001 | Init project + flavor | `flutter create` (org `vn.kontum.gis`); cấu hình 3 flavor dev/staging/prod (Android productFlavors + iOS scheme); `--dart-define-from-file` cho `API_BASE_URL`, `GEOSERVER_URL`, `GOOGLE_CLIENT_ID`; app icon + splash (flutter_native_splash) | P0 | 8h | — |
| MB-002 | Lint + CI | analysis_options (very_good_analysis hoặc flutter_lints strict); GitHub Actions: analyze + test + build APK debug mỗi PR; format check | P0 | 6h | MB-001 |
| MB-003 | Theme Material 3 | bảng màu (xanh rừng chủ đạo), typography, dark mode, component theme (button, card, chip trạng thái, input); file `app/theme/` | P0 | 8h | MB-001 |
| MB-004 | i18n khung | flutter_localizations + ARB `vi` (mặc định), `en` khung; helper `context.l10n`; quy ước key theo feature | P0 | 4h | MB-001 |
| MB-005 | Router + shell | go_router: splash → onboarding → auth → `StatefulShellRoute` 5 tab; guard theo trạng thái auth + role; khai báo route name constants | P0 | 8h | MB-001 |
| MB-006 | Network layer | dio singleton qua Riverpod; interceptors: auth header, anonymous-id, Accept-Language, log (dev only), retry idempotent GET; parse envelope `{success,data,message,pagination}` → `ApiResponse<T>`; mapper `AppException` | P0 | 10h | MB-001 |
| MB-007 | Refresh-token interceptor | queue request khi đang refresh (Completer mutex); rotation; test race 3 request song song gặp 401 | P0 | 8h | MB-006 |
| MB-008 | Storage layer | flutter_secure_storage (token), shared_preferences (cài đặt, onboarding flag, last_synced_at), khởi tạo drift database + migration runner | P0 | 6h | MB-001 |
| MB-009 | Shared widgets | AppScaffold, shimmer skeleton, EmptyState, ErrorState + retry, OfflineBanner (connectivity_plus stream), StatusBadge, ConfirmDialog, paginated ListView helper (infinite scroll) | P0 | 10h | MB-003 |
| MB-010 | Permission & role helper | enum `UserRole`, extension `can(...)` khớp bảng quyền doc 01 §2; widget `RoleGate(roles:[], child:)`; provider currentUser | P0 | 4h | MB-006 |
| MB-011 | Crash & analytics | Firebase Crashlytics (hoặc Sentry) + log breadcrumb điều hướng; opt-out trong cài đặt | P1 | 4h | MB-001 |

**Tổng M-EP-00: ~76h (~13 ngày)**

## M-EP-01 — Xác thực & tài khoản

| ID | Task | Chi tiết | Ưu tiên | Ước lượng | Phụ thuộc |
|---|---|---|---|---|---|
| MB-020 | Auth repository + models | freezed `User`, `AuthTokens`; repo: login/register/refresh/logout/me/updateMe; unit test với mock dio | P0 | 8h | MB-006, MB-008 |
| MB-021 | Màn đăng nhập (SCR-A03) | form + validate, hiện lỗi 401/429 (đếm ngược rate-limit), loading state, nút khách | P0 | 6h | MB-020 |
| MB-022 | Đăng nhập Google | google_sign_in cấu hình Android (SHA-1) + iOS (URL scheme); gọi `/auth/google/mobile`; xử lý huỷ giữa chừng; xử lý tài khoản mới cần set-password | P0 | 8h | MB-020 |
| MB-023 | Đăng ký + xác thực email (SCR-A04, A05) | form đăng ký; màn nhập mã xác thực + resend cooldown; deep-link `verify-email` | P0 | 8h | MB-020 |
| MB-024 | Quên mật khẩu (SCR-A06) | flow 2 bước, validate mật khẩu mạnh khớp rule server | P1 | 5h | MB-020 |
| MB-025 | Chế độ khách (anonymous) | sinh + lưu `x-anonymous-id`; banner mời đăng nhập ở tab Thông báo; luồng nâng cấp khách → đăng ký (giữ anonymous-id để feedback cũ vẫn xem được) | P0 | 5h | MB-020 |
| MB-026 | Phiên & auto-login | splash kiểm tra token → `GET /auth/me`; logout: revoke + `DELETE /notifications/devices` + xoá secure storage; xử lý cờ bắt đổi mật khẩu → SCR-A07 | P0 | 6h | MB-020, MB-007 |
| MB-027 | Hồ sơ + đổi mật khẩu (SCR-G02, G03) | form sửa tên/SĐT, đổi MK, validate; avatar chữ cái | P1 | 5h | MB-026 |

**Tổng M-EP-01: ~51h (~9 ngày)**

## M-EP-02 — Bản đồ lõi

| ID | Task | Chi tiết | Ưu tiên | Ước lượng | Phụ thuộc |
|---|---|---|---|---|---|
| MB-030 | Spike maplibre_gl | PoC hiển thị nền OSM + 1 lớp WMS GeoServer Kon Tum trên Android & iOS thật; đo FPS, quyết định maplibre vs flutter_map; **output: ADR ngắn** | P0 | 8h | MB-001 |
| MB-031 | Map screen khung (SCR-B01) | widget bản đồ full-screen trong tab; camera mặc định bbox Kon Tum; nút zoom, compass, scale bar; state camera qua provider | P0 | 8h | MB-030 |
| MB-032 | Layer catalog service | repo `GET /map/layers` → model `MapLayer` (code, group, type, url, style, zoom range); cache drift 24h; xử lý layer public vs cần đăng nhập | P0 | 6h | MB-006 |
| MB-033 | Render lớp WMS/WMTS động | add/remove raster source theo lựa chọn; opacity per-layer; thứ tự z-index theo group; persist lựa chọn lớp giữa các phiên | P0 | 10h | MB-031, MB-032 |
| MB-034 | Bottom sheet chọn lớp (SCR-B02) | nhóm theo `group`, switch bật/tắt, slider opacity, ảnh legend GetLegendGraphic, tìm nhanh lớp | P0 | 8h | MB-033 |
| MB-035 | Định vị GPS | geolocator: permission flow (denied/deniedForever kèm hướng dẫn mở Settings), nút my-location, chấm vị trí + vòng accuracy, theo dõi hướng la bàn | P0 | 6h | MB-031 |
| MB-036 | Identify đối tượng (SCR-B03) | tap → GetFeatureInfo lớp đang bật (ưu tiên lớp trên cùng) → bottom sheet thuộc tính (label từ schema `GET /map/layers/:code`); nút "Cập nhật đối tượng" gate role so_nnmt | P0 | 10h | MB-033 |
| MB-037 | Tìm đường (SCR-B04) | chọn điểm đến (tap/tìm địa danh Nominatim); gọi OSRM public; vẽ polyline, hiện km + phút; disclaimer dữ liệu | P1 | 10h | MB-035 |
| MB-038 | Công cụ đo đạc (SCR-B05) | mode vẽ điểm/line/polygon bằng tap; mode GPS-track (đi bộ ghi vệt); tính chiều dài/diện tích (turf-dart / công thức geodesic); undo/clear; gate so_nnmt | P0 | 12h | MB-035 |
| MB-039 | Cache tile offline | cache tile đã xem (LRU ~200MB); nút "tải vùng offline" chọn bbox + zoom range cho khu vực công tác | P2 | 12h | MB-033 |
| MB-040 | Ảnh viễn thám overlay (SCR-F03) | list ảnh `GET /remote-sensing/images`; overlay COG từ `/cog-url`; so sánh swipe 2 ảnh (P2) | P1 | 8h | MB-033 |

**Tổng M-EP-02: ~98h (~17 ngày)**

## M-EP-03 — Thời tiết trên bản đồ

| ID | Task | Chi tiết | Ưu tiên | Ước lượng | Phụ thuộc |
|---|---|---|---|---|---|
| MB-045 | Weather layers toggle (SCR-B06) | chip chọn mây/mưa/nhiệt; raster source từ `/weather/tiles/:type/{z}/{x}/{y}`; opacity mặc định 0.7 | P1 | 6h | MB-033 |
| MB-046 | Thời tiết điểm | long-press hoặc nút → `GET /weather/point` → card: nhiệt độ, ẩm, gió, mưa; tự lấy tại vị trí GPS khi mở | P1 | 5h | MB-035 |
| MB-047 | Lớp gió particle | `GET /weather/wind-grid?bbox=` → CustomPainter particle animation; throttle khi pan/zoom; tắt khi máy yếu | P2 | 12h | MB-045 |

**Tổng M-EP-03: ~23h (~4 ngày)**

## M-EP-04 — Tin tức / Văn bản / Bản đồ PDF

| ID | Task | Chi tiết | Ưu tiên | Ước lượng | Phụ thuộc |
|---|---|---|---|---|---|
| MB-050 | News list (SCR-D01) | repo + infinite scroll, search debounce, filter chuyên mục, pull-refresh; cache 20 tin mới nhất vào drift để đọc offline | P0 | 8h | MB-009 |
| MB-051 | News detail (SCR-D02) | render HTML (flutter_html/flutter_widget_from_html), hero ảnh, share, deep-link slug | P0 | 6h | MB-050 |
| MB-052 | Bình luận tin | list + viết + xoá của mình (đăng nhập); optimistic update | P2 | 6h | MB-051 |
| MB-053 | Văn bản (SCR-D03) | list + search số hiệu/trích yếu/loại; detail + mở file: PDF viewer in-app (pdfx), file khác mở external; cache file đã tải | P0 | 8h | MB-009 |
| MB-054 | Bản đồ PDF (SCR-D04) | list `GET /pdf-maps` + viewer PDF (zoom sâu), tải về; hiển thị dung lượng trước khi tải | P1 | 5h | MB-053 |

**Tổng M-EP-04: ~33h (~6 ngày)**

## M-EP-05 — Phản ánh hiện trạng (feedback) + offline

| ID | Task | Chi tiết | Ưu tiên | Ước lượng | Phụ thuộc |
|---|---|---|---|---|---|
| MB-060 | Outbox engine (core/sync) | bảng drift `outbox` theo doc 03 §3; sync engine: trigger online/app-resume, FIFO, backoff, phân loại lỗi 4xx vs mạng; expose stream trạng thái cho OfflineBanner; **unit test kỹ: mất mạng giữa chừng, gửi trùng, 5 lần fail** | P0 | 14h | MB-008 |
| MB-061 | Camera & nén ảnh | chụp/chọn multi (≤10); nén ≤1920px/q80/<5MB; preview grid xoá-sửa; giữ EXIF GPS theo cài đặt; xử lý permission camera/photos 2 nền tảng | P0 | 8h | MB-001 |
| MB-062 | Form gửi phản ánh (SCR-C02) | mô tả (≥10 ký tự), loại phản ánh, đính kèm MB-061, vị trí: GPS hiện tại (hiện accuracy) hoặc chọn trên minimap; guest gửi bằng anonymous-id; submit → ghi outbox → sync ngay nếu online; multipart đúng field `media` | P0 | 12h | MB-060, MB-061, MB-035 |
| MB-063 | Danh sách của tôi (SCR-C01) | merge outbox (pending/error) + server (`GET /feedback/mine`); badge trạng thái new/in_progress/resolved + pending sync; filter trạng thái | P0 | 8h | MB-062 |
| MB-064 | Chi tiết phản ánh (SCR-C03) | gallery ảnh, minimap vị trí, timeline trạng thái từ statusLogs | P0 | 6h | MB-063 |
| MB-065 | Màn hàng đợi offline (SCR-C06) | list outbox mọi loại, lỗi validation hiển thị rõ, retry/xoá từng bản, retry all | P0 | 5h | MB-060 |
| MB-066 | Xử lý phản ánh cho cán bộ (SCR-C07) | list `GET /admin/feedback` + filter; đổi trạng thái `PATCH /admin/feedback/:id/status` + ghi chú; gate quyền `feedback.update_status` | P1 | 8h | MB-063 |
| MB-067 | Xem phản ánh trên bản đồ (cán bộ/ubnd) | layer điểm từ `GET /admin/feedback/map` (GeoJSON) trên map chính, cluster, tap → mở chi tiết | P1 | 6h | MB-036, MB-066 |

**Tổng M-EP-05: ~67h (~11 ngày)**

## M-EP-06 — Field-update kiểm lâm (EP-10 server)

| ID | Task | Chi tiết | Ưu tiên | Ước lượng | Phụ thuộc |
|---|---|---|---|---|---|
| MB-070 | Field-update repo + model | freezed model khớp validator server (`layerCode`, `featureId?`, lng 106–109, lat 13–16.5, `attributes`, `clientUuid`, `note`); validate client trước khi ghi outbox | P0 | 5h | MB-060 |
| MB-071 | Form tạo field-update (SCR-C04) | bước 1 chọn layer điểm (từ catalog, filter editable); bước 2 lấy GPS — cảnh báo nếu accuracy >15m, cho phép chờ/ghi đè tay; bước 3 form thuộc tính **động theo schema layer** (text/number/select/date); bước 4 ghi chú + xác nhận → outbox | P0 | 14h | MB-070, MB-034, MB-035 |
| MB-072 | Gắn với đối tượng có sẵn | từ identify (SCR-B03) bấm "Cập nhật đối tượng này" → form MB-071 prefill `featureId` + thuộc tính hiện có | P0 | 6h | MB-071, MB-036 |
| MB-073 | Sync tăng dần | sau khi outbox rỗng gọi `GET /mobile/sync?since=last_synced_at`; merge kết quả vào drift; cập nhật mốc; xử lý lần đầu (không `since`) | P0 | 6h | MB-070 |
| MB-074 | Danh sách + chi tiết field-update (SCR-C05) | list của tôi (local + synced), trạng thái đồng bộ, chi tiết thuộc tính, vị trí minimap | P0 | 6h | MB-073 |

**Tổng M-EP-06: ~37h (~6 ngày)**

## M-EP-07 — Thông báo & FCM

| ID | Task | Chi tiết | Ưu tiên | Ước lượng | Phụ thuộc |
|---|---|---|---|---|---|
| MB-080 | Firebase setup | tạo project FCM, google-services.json/GoogleService-Info.plist theo flavor, APNs key iOS; xin quyền notification (Android 13+ POST_NOTIFICATIONS) | P0 | 6h | MB-001 |
| MB-081 | Đăng ký device token | sau login gọi `POST /notifications/devices`; lắng nghe onTokenRefresh; logout gọi DELETE; guest không đăng ký | P0 | 5h | MB-080, MB-026 |
| MB-082 | Nhận & hiển thị push | foreground: flutter_local_notifications; background/terminated: xử lý tap → deep-link (`kontumgis://map?...`, `feedback/:id`, `news/:slug`); test 3 trạng thái app trên 2 nền tảng | P0 | 10h | MB-080, MB-005 |
| MB-083 | Màn thông báo (SCR-E01) | list phân trang, unread-count badge tab (poll khi mở app + sau push), mark read/read-all, swipe xoá | P0 | 8h | MB-006 |
| MB-084 | Cài đặt thông báo (SCR-E02) | toggle push on/off (đăng ký/huỷ device); mục "cảnh báo gần vị trí" ẩn chờ EP-06 | P1 | 4h | MB-081 |

**Tổng M-EP-07: ~33h (~6 ngày)**

## M-EP-08 — Thống kê (ubnd_tinh / system_admin)

| ID | Task | Chi tiết | Ưu tiên | Ước lượng | Phụ thuộc |
|---|---|---|---|---|---|
| MB-090 | Dashboard (SCR-F01) | card tổng: tổng diện tích rừng, độ che phủ; bar chart theo huyện (`/stats/administrative-units`), pie lớp phủ (`/stats/landcover`); gate role | P1 | 10h | MB-010 |
| MB-091 | Biến động rừng (SCR-F02) | picker 2 mốc thời gian → `GET /spatial/forest-change`; bảng + chart tăng/giảm; xử lý 403 nếu thiếu quyền `spatial.read` | P1 | 8h | MB-090 |
| MB-092 | Báo cáo hiện trường cho UBND | view tổng hợp feedback + field-update theo huyện/trạng thái (dùng `GET /admin/feedback` + filter); export share ảnh chart | P2 | 8h | MB-066 |

**Tổng M-EP-08: ~26h (~4.5 ngày)**

## M-EP-09 — ⛔ Cảnh báo cháy (block bởi server EP-06)

> Chỉ start khi server phát hành `/fire-risk/*`. Spec app viết sẵn để estimate.

| ID | Task | Chi tiết | Ưu tiên | Ước lượng | Phụ thuộc |
|---|---|---|---|---|---|
| MB-100 | Lớp bản đồ cảnh báo cháy (SCR-B07) | điểm cháy FIRMS + polygon cấp nguy cơ (màu theo cấp I–V); auto-refresh; legend cấp | P0* | 8h | ⛔ server EP-06, MB-033 |
| MB-101 | Cảnh báo gần vị trí | `GET /mobile/alerts/nearby` theo GPS; card cảnh báo trên map + mục trong tab Thông báo | P0* | 6h | ⛔ EP-06, MB-035 |
| MB-102 | Đăng ký vùng nhận cảnh báo | chọn bán kính quanh vị trí/điểm chọn → `POST /fire-risk/subscribe`; quản lý subscription trong SCR-E02 | P1* | 6h | ⛔ EP-06, MB-084 |
| MB-103 | Push cảnh báo cháy end-to-end | nhận push cấp ≥4 → deep-link mở map focus vùng cảnh báo; test thiết bị thật | P0* | 5h | MB-100, MB-082 |

**Tổng M-EP-09: ~25h (~4 ngày)** — *ưu tiên P0 trong release chứa nó.

## M-EP-10 — Chất lượng & phát hành

| ID | Task | Chi tiết | Ưu tiên | Ước lượng | Phụ thuộc |
|---|---|---|---|---|---|
| MB-110 | Test offline sync tổng hợp | integration test: tạo 3 feedback + 2 field-update khi airplane mode → bật mạng → tất cả synced, không trùng (kiểm tra bằng client_uuid), thứ tự đúng | P0 | 8h | MB-062, MB-073 |
| MB-111 | Test luồng auth | integration: login/refresh hết hạn/logout/guest→register; golden test màn auth | P0 | 6h | M-EP-01 |
| MB-112 | Test bản đồ thủ công (checklist) | checklist thiết bị thật: Android low-end (2GB RAM), Android mid, iPhone; FPS pan/zoom với 3 lớp bật, GPS trong nhà/ngoài trời, đo đạc vệt 500m | P0 | 8h | M-EP-02 |
| MB-113 | Test push e2e | script server gửi push thật → 3 trạng thái app × Android/iOS, deep-link đúng màn | P0 | 5h | MB-082 |
| MB-114 | Accessibility & UX pass | touch target ≥48dp, contrast, font-scale 1.3 không vỡ layout, haptic khi đo đạc | P1 | 6h | trước release |
| MB-115 | Hardening | ProGuard/R8 rules, chống chụp màn hình màn nhạy cảm (không cần), certificate pinning (P2), kiểm tra không log token | P1 | 5h | MB-006 |
| MB-116 | Release Android | keystore, App Bundle, Play Console (internal → closed testing), privacy policy URL, data safety form (location, camera) | P0 | 8h | tất cả P0 |
| MB-117 | Release iOS | Apple Developer, provisioning, TestFlight, App Privacy khai báo vị trí/camera, review notes tài khoản demo | P0 | 10h | tất cả P0 |
| MB-118 | Tài liệu bàn giao | README repo app (setup, flavor, codegen), hướng dẫn build release, CHANGELOG | P1 | 4h | MB-116 |

**Tổng M-EP-10: ~60h (~10 ngày)**

---

## Tổng hợp

| Epic | Nội dung | Ước lượng | Ưu tiên chính |
|---|---|---|---|
| M-EP-00 | Foundation | 76h | P0 |
| M-EP-01 | Auth & tài khoản | 51h | P0 |
| M-EP-02 | Bản đồ lõi | 98h | P0 |
| M-EP-03 | Thời tiết | 23h | P1 |
| M-EP-04 | Tin tức/Văn bản | 33h | P0 |
| M-EP-05 | Phản ánh + offline | 67h | P0 |
| M-EP-06 | Field-update kiểm lâm | 37h | P0 |
| M-EP-07 | Thông báo & FCM | 33h | P0 |
| M-EP-08 | Thống kê | 26h | P1 |
| M-EP-09 | Cảnh báo cháy | 25h | ⛔ chờ server |
| M-EP-10 | QA & release | 60h | P0 |
| **Tổng** | | **~529h ≈ 88 ngày công** | 2 dev ≈ 9–10 tuần |
