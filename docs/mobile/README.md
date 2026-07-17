# MobileGIS Kon Tum — Bộ tài liệu thiết kế App Flutter

> App di động Flutter dùng chung Backend `/api/v1` (repo `server-kontum`).
> Tài liệu nghiệp vụ gốc: `docs/modules/09-mobilegis-design.md`, ma trận chức năng theo quyền (bảng "Danh sách chức năng chi tiết theo quyền").

| # | Tài liệu | Nội dung |
|---|----------|----------|
| 01 | [01-app-overview.md](./01-app-overview.md) | Mục tiêu, vai trò người dùng, tech stack, kiến trúc app, cấu trúc thư mục |
| 02 | [02-screen-flows.md](./02-screen-flows.md) | Danh sách màn hình, luồng điều hướng, mô tả UI từng màn theo quyền |
| 03 | [03-api-mapping.md](./03-api-mapping.md) | Ánh xạ tính năng ↔ API server, luồng auth, giao thức offline sync, xử lý lỗi |
| 04 | [04-task-breakdown.md](./04-task-breakdown.md) | Backlog chi tiết: Epic → Story → Task (ID, ước lượng, phụ thuộc, DoD) |
| 05 | [05-sprint-plan.md](./05-sprint-plan.md) | Kế hoạch sprint, milestone, rủi ro & phụ thuộc server |
| 06 | [06-news-comment-api-update.md](./06-news-comment-api-update.md) | Log cập nhật API news/comment theo slug |
| 07 | [07-field-measurement-design.md](./07-field-measurement-design.md) | Đo đạc thực địa & theo dõi biến động (M-EP-11) — thay thế M-EP-06 đã stale |

## Quy ước ID
- Epic mobile: `M-EP-xx`
- Task: `MB-xxx` (đánh số liên tục, không trùng)
- Phụ thuộc server ghi rõ `⛔ server:` (ví dụ `⛔ server: EP-06 fire-risk chưa có API`).

## Trạng thái phía server (thời điểm 07/2026)
- ✅ Auth (email + Google mobile), Users, News, Documents, PDF-maps, Feedback, Map layers (GeoServer), Weather, Remote sensing, Statistics, Spatial, Notifications + device token.
- ✅ **Đo đạc thực địa & theo dõi biến động** (`gis.field_measurements`, `gis.monitored_areas`) — đã có API, đã test thật (2026-07-13). Xem [07-field-measurement-design.md](./07-field-measurement-design.md) / `M-EP-11`.
- ⚠️ **Mobile field-updates + sync cũ đã bị gỡ** (`field.field_updates` DROP ở migration 027, route `/mobile/*` không còn tồn tại) — `M-EP-06` trong `04-task-breakdown.md` đang stale, đừng code theo epic đó nữa.
- ⛔ **EP-06 Fire risk (cảnh báo cháy)**: chưa có endpoint `/fire-risk/*`, `/mobile/alerts/nearby` — các task app liên quan bị block, đã tách riêng trong backlog (`M-EP-09` mobile).
