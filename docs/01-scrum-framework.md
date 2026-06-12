# 01 — Scrum Framework (Khung quy trình Agile Scrum)

## 1. Vì sao chọn Scrum

Dự án có nhiều module độc lập (auth, bản đồ, vệ tinh, thời tiết, cháy rừng, phản ánh, mobile), yêu cầu thay đổi theo phản hồi cơ quan chủ quản và phụ thuộc dữ liệu ngoài (GEE, FIRMS). Scrum cho phép giao tăng dần (incremental), kiểm tra–thích nghi (inspect & adapt) sau mỗi sprint.

## 2. Vai trò (Scrum Team)

| Vai trò | Trách nhiệm | Gợi ý nhân sự |
|--------|-------------|---------------|
| **Product Owner (PO)** | Sở hữu Product Backlog, ưu tiên giá trị, nghiệm thu | Đại diện Sở NN&MT + phân tích nghiệp vụ |
| **Scrum Master (SM)** | Bảo vệ quy trình, gỡ vướng (impediment), facilitate | Tech lead/PM |
| **Development Team** | Tự tổ chức, đa kỹ năng, giao Increment | BE, FE/WebGIS, Mobile, GIS/Data, QA (4–6 người) |
| **Stakeholders** | Cung cấp yêu cầu, phản hồi tại Review | UBND tỉnh, Kiểm lâm |

## 3. Cadence (Nhịp làm việc)

- **Độ dài Sprint:** 2 tuần.
- **Giờ làm việc lõi:** thống nhất khung overlap cho daily.

## 4. Sự kiện Scrum (Ceremonies)

| Sự kiện | Thời lượng (sprint 2 tuần) | Mục tiêu | Đầu ra |
|---------|----------------------------|----------|--------|
| Sprint Planning | ≤ 4h | Chọn Sprint Goal + Backlog items | Sprint Backlog |
| Daily Scrum | 15 phút/ngày | Đồng bộ, lộ impediment | Cập nhật kế hoạch ngày |
| Backlog Refinement | ~1h/tuần | Làm mịn, estimate item sắp tới | Backlog sẵn sàng |
| Sprint Review | ≤ 2h | Demo Increment, lấy feedback | Backlog điều chỉnh |
| Sprint Retrospective | ≤ 1.5h | Cải tiến quy trình | Action items |

## 5. Artifacts (Sản phẩm công việc)

1. **Product Backlog** — danh sách Epic/Story ưu tiên (xem `02-product-backlog.md`).
2. **Sprint Backlog** — tập item + Sprint Goal cho 1 sprint.
3. **Increment** — phần sản phẩm "Done", có thể chạy được.

## 6. Definition of Ready (DoR) — Story đủ điều kiện vào Sprint

- [ ] Có mô tả theo mẫu "As a … I want … so that …".
- [ ] Acceptance Criteria rõ ràng, kiểm thử được (Gherkin Given/When/Then).
- [ ] Đã estimate Story Point (Planning Poker, dãy Fibonacci).
- [ ] Phụ thuộc dữ liệu/dịch vụ ngoài đã xác định (GEE key, FIRMS…).
- [ ] Không lớn hơn 8 SP (nếu lớn hơn phải tách).
- [ ] UI/UX mockup (nếu cần) đã đính kèm.

## 7. Definition of Done (DoD) — Áp dụng mọi Story

- [ ] Code theo chuẩn dự án (ESLint pass — đã có `.eslintrc.js`).
- [ ] Pattern phân lớp: route → controller → service → repository.
- [ ] Validate input bằng Joi; trả lỗi qua `core/error.response.js`.
- [ ] Thành công trả qua `core/success.response.js`; thông điệp song ngữ (i18n).
- [ ] Có migration SQL nếu đổi schema; idempotent (`IF NOT EXISTS`).
- [ ] Unit/integration test cho logic chính; pass CI.
- [ ] Cập nhật API doc (`06-api-design.md`) + ghi chú `.env` nếu thêm biến.
- [ ] Không hardcode secret; tuân thủ rate-limit & RBAC.
- [ ] Đã review (≥1 reviewer) + merge vào nhánh tích hợp.

## 8. Ước lượng (Estimation)

- Đơn vị: **Story Point (SP)** theo Fibonacci `1,2,3,5,8,13`.
- Quy chiếu tham khảo: 1 SP ≈ nửa ngày công lý tưởng. Story > 8 SP → tách nhỏ.
- **Velocity** dự kiến khởi điểm: 20–25 SP/sprint (hiệu chỉnh sau Sprint 1–2).

## 9. Quy ước Git & nhánh

- `main` (production) ← `develop` (tích hợp) ← `feature/US-xxx-mo-ta`.
- Commit theo Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`.
- PR phải qua review + CI xanh; không push thẳng `main`/`develop`.

## 10. Công cụ đề xuất

| Mục đích | Công cụ |
|----------|---------|
| Backlog/Board | Jira / GitHub Projects |
| Repo & CI | GitHub + GitHub Actions |
| Tài liệu | Markdown trong repo (`/docs`) + Mermaid |
| Liên lạc | Slack/Teams |
| Thiết kế UI | Figma |
