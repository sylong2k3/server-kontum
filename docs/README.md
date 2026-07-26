# Tài liệu dự án WebGIS/MobileGIS Giám sát Môi trường & Cháy rừng tỉnh Kon Tum

> Bộ tài liệu Agile Scrum + Thiết kế hệ thống. Brainstorm và biên soạn bám sát mã nguồn hiện có (`server-kontum`: Node.js/Express 5 + PostgreSQL/PostGIS).

## Mục lục

| # | Tài liệu | Nội dung |
|---|----------|----------|
| 00 | [Project Charter](./00-project-charter.md) | Tầm nhìn, mục tiêu, phạm vi, stakeholders, rủi ro |
| 01 | [Scrum Framework](./01-scrum-framework.md) | Vai trò, sự kiện, artifacts, DoR/DoD, quy ước |
| 02 | [Product Backlog](./02-product-backlog.md) | Epics, User Stories, Acceptance Criteria, Story Points |
| 03 | [Release & Sprint Plan](./03-release-sprint-plan.md) | Roadmap, chia sprint, burndown mẫu |
| 04 | [System Architecture](./architecture/04-system-architecture.md) | Kiến trúc tổng thể, tech stack, deployment |
| 05 | [Database Design](./architecture/05-database-design.md) | Schemas, ERD, bảng PostGIS |
| 06 | [API Design](./architecture/06-api-design.md) | Đặc tả REST API theo module |
| 07 | [Fire Risk Module](./modules/07-fire-risk-design.md) | Thiết kế chi tiết module dự báo cháy rừng |
| 08 | [Weather & Satellite Module](./modules/08-weather-satellite-design.md) | Thời tiết + ảnh vệ tinh (GEE) |
| 09 | [MobileGIS Module](./modules/09-mobilegis-design.md) | Ứng dụng di động, phản ánh hiện trường |
| 10 | [Traceability Matrix](./10-traceability-matrix.md) | Ánh xạ đặc tả gốc → Epic/Story, câu hỏi mở |
| 11 | [Test & QA Strategy](./11-test-qa-strategy.md) | Chiến lược kiểm thử, môi trường, CI |
| 12 | [GeoServer Integration](./modules/12-geoserver-integration-design.md) | Metadata layer, publish/unpublish, GeoServer REST, public OGC endpoints |
| 13 | [GeoServer + PostGIS & GeoTIFF Guide](./guides/13-geoserver-postgis-setup-guide.md) | Hướng dẫn thực hành: vector PostGIS + raster GeoTIFF/ImageMosaic → Mapbox |
| 14 | [Functional Spec chi tiết](./14-functional-spec-detailed.md) | Đặc tả field-level từng chức năng (input/validate/nghiệp vụ/lỗi) |
| 15 | [Dev Workflow: Debug & Review](./15-dev-workflow-debug-review.md) | Vòng đời Story, bước debug, checklist code review, branch protection |
| 16 | [Hướng dẫn sử dụng Postman Collection](./guides/16-postman-guide.md) | Import, đăng nhập lấy token, chạy Runner/Newman, đọc test 400, checklist đồng bộ khi thêm endpoint |
| M | [Mobile App (Flutter)](./mobile/README.md) | Bộ tài liệu thiết kế app MobileGIS: kiến trúc, màn hình, API mapping, backlog task chi tiết, sprint plan |

## Trạng thái dự án (tại thời điểm biên soạn)

**Đã hoàn thành (trong mã nguồn):**
- Khung Express 5 với middleware bảo mật (helmet, cors, rate-limit, compression).
- Hệ thống Auth đầy đủ: đăng ký/đăng nhập, JWT access+refresh, Google OAuth, xác thực email, reset mật khẩu, dọn token (cron).
- Phân quyền 4 vai trò: `system_admin`, `ubnd_tinh`, `so_nnmt`, `citizen`.
- PostGIS đã bật, đã tạo schema `gis`, `fire`, `cms`, `field`.
- WebSocket server, i18n song ngữ, upload middleware.

**Chưa làm (đã chừa chỗ trong `routes/index.js` + `.env.example`):**
- Module bản đồ/lớp dữ liệu, metadata GIS, ảnh vệ tinh (GEE), thời tiết, fire-risk, thống kê, phân tích không gian, tin tức, văn bản, phản ánh, MobileGIS.

## Quy ước tài liệu
- Ngôn ngữ chính: Tiếng Việt. Thuật ngữ kỹ thuật giữ nguyên tiếng Anh.
- ID truy vết: `EP-xx` (Epic), `US-xxx` (User Story), `NFR-xx` (Non-functional).
- Sơ đồ dùng cú pháp Mermaid để render trực tiếp trên Git/GitHub.
