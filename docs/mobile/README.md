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

## Quy ước ID
- Epic mobile: `M-EP-xx`
- Task: `MB-xxx` (đánh số liên tục, không trùng)
- Phụ thuộc server ghi rõ `⛔ server:` (ví dụ `⛔ server: EP-06 fire-risk chưa có API`).

## Trạng thái phía server (thời điểm 07/2026)
- ✅ Auth (email + Google mobile), Users, News, Documents, PDF-maps, Feedback, Map layers (GeoServer), Weather, Remote sensing, Statistics, Spatial, Notifications + device token, Mobile field-updates + sync.
- ⛔ **EP-06 Fire risk (cảnh báo cháy)**: chưa có endpoint `/fire-risk/*`, `/mobile/alerts/nearby` — các task app liên quan bị block, đã tách riêng trong backlog.
