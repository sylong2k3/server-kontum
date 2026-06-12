# 03 — Release & Sprint Plan

## 1. Chiến lược phát hành (Release Strategy)

Phát hành theo 3 mốc (Milestone), mỗi mốc là một Increment có thể demo cho cơ quan chủ quản.

| Release | Tên | Mục tiêu | Epics chính |
|---------|-----|----------|-------------|
| **R1 — MVP Nền tảng & Bản đồ** | "Bản đồ sống" | Đăng nhập, RBAC, WebGIS với lớp dữ liệu công khai, thời tiết cơ bản | EP-01, EP-02, EP-03, EP-05, EP-11 |
| **R2 — Cảnh báo cháy rừng** | "Cảnh báo sớm" | Pipeline GEE→PostGIS, FireRisk, FIRMS, cảnh báo Web + push | EP-04, EP-06, EP-09 |
| **R3 — Hoàn thiện & Mobile** | "Toàn diện" | MobileGIS, phân tích không gian, thống kê, CMS | EP-07, EP-08, EP-10 |

## 2. Giả định năng lực

- Velocity khởi điểm: **22 SP/sprint** (hiệu chỉnh sau Sprint 1–2).
- Sprint dài 2 tuần. Tổng backlog ~359 SP; trừ phần Auth đã Done (~30 SP) → còn ~329 SP → ~15 sprint (~7.5 tháng) cho full scope.

## 3. Roadmap (Mermaid Gantt)

```mermaid
gantt
    title Roadmap WebGIS/MobileGIS Kon Tum
    dateFormat  YYYY-MM-DD
    axisFormat  %m/%y

    section R1 - Nền tảng & Bản đồ
    Sprint 0 - Setup/CI/Hạ tầng      :s0, 2026-06-15, 14d
    Sprint 1 - User mgmt + Map layers:s1, after s0, 14d
    Sprint 2 - WebGIS core + GeoServer:s2, after s1, 14d
    Sprint 3 - Thời tiết + hoàn thiện R1:s3, after s2, 14d

    section R2 - Cảnh báo cháy
    Sprint 4 - GEE pipeline + ảnh vệ tinh:s4, after s3, 14d
    Sprint 5 - FireRisk + phân cấp       :s5, after s4, 14d
    Sprint 6 - FIRMS + cảnh báo ưu tiên  :s6, after s5, 14d
    Sprint 7 - Feedback + push + hoàn thiện R2:s7, after s6, 14d

    section R3 - Mobile & Phân tích
    Sprint 8 - MobileGIS core      :s8, after s7, 14d
    Sprint 9 - Mobile field + sync :s9, after s8, 14d
    Sprint 10 - Phân tích + thống kê:s10, after s9, 14d
    Sprint 11 - CMS + bàn giao     :s11, after s10, 14d
```

## 4. Chi tiết Sprint (R1 + đầu R2)

### Sprint 0 — Khởi tạo (Setup)
**Goal:** Sẵn sàng môi trường, CI, chuẩn hóa pipeline dữ liệu.
- US-101 CI lint+test (5)
- US-100 Khung cron ingestion ổn định (8)
- US-103 Backup PostGIS (3)
- Spike: kết nối GEE service account, FIRMS key (3)
- **Tổng: ~19 SP**

### Sprint 1 — Quản trị người dùng + Lớp dữ liệu
**Goal:** Admin quản lý user; định nghĩa & CRUD lớp dữ liệu bản đồ.
- US-010 CRUD/khóa/soft delete user (8)
- US-012 Danh sách user phân trang (3)
- US-020 CRUD map layers metadata (8)
- US-011 Hồ sơ cá nhân (5) *(stretch)*
- **Tổng: ~19–24 SP**

### Sprint 2 — WebGIS core
**Goal:** Người dân xem lớp công khai + popup; proxy GeoServer.
- US-021 Import shapefile/GeoJSON (13)
- US-022 API features theo bbox (8)
- **Tổng: ~21 SP**

### Sprint 3 — WebGIS tương tác + Thời tiết → chốt R1
**Goal:** Layer switcher/3D, feature-info, thời tiết.
- US-023 Feature-info popup (5)
- US-024 Proxy WMS/WFS GeoServer (8)
- US-026 Layer switcher + 3D (5)
- US-040 Lớp thời tiết (8) *(stretch)*
- **Tổng: ~18–26 SP** → **Release R1**

### Sprint 4 — GEE pipeline + Ảnh vệ tinh
**Goal:** Tìm/xem Sentinel-2 + chỉ số.
- US-030 Tìm/xem Sentinel-2 (13)
- US-031 NDVI/NDMI/NBR (8)
- **Tổng: ~21 SP**

### Sprint 5 — Lõi FireRisk
**Goal:** Tính & phân cấp nguy cơ cháy, lưu PostGIS.
- US-050 Tính FireRisk cron (13)
- US-051 Phân cấp + lưu PostGIS (8)
- **Tổng: ~21 SP**

### Sprint 6 — FIRMS + Cảnh báo
- US-052 Ingest FIRMS (8)
- US-053 Bản đồ nguy cơ + popup (5)
- US-054 Cảnh báo ưu tiên (8)
- **Tổng: ~21 SP**

### Sprint 7 — Feedback + Push → chốt R2
- US-080 Gửi phản ánh (8)
- US-081 Xử lý phản ánh (5)
- US-055 Push FCM theo vị trí (8)
- **Tổng: ~21 SP** → **Release R2**

> Sprint 8–11 (R3) làm mịn ở Backlog Refinement trước khi vào.

## 5. Burndown mẫu (1 sprint 22 SP)

```mermaid
xychart-beta
    title "Sprint Burndown (lý tưởng vs thực tế)"
    x-axis [D1, D2, D3, D4, D5, D6, D7, D8, D9, D10]
    y-axis "SP còn lại" 0 --> 22
    line [22, 20, 17, 15, 13, 11, 9, 6, 3, 0]
    line [22, 22, 20, 18, 17, 14, 12, 10, 5, 0]
```

## 6. Quản trị phụ thuộc

```mermaid
flowchart LR
    EP01[EP-01 Auth/RBAC] --> EP02[EP-02 User mgmt]
    EP01 --> EP03[EP-03 Map layers]
    EP03 --> EP04[EP-04 Satellite/GEE]
    EP04 --> EP06[EP-06 Fire Risk]
    EP05[EP-05 Weather] --> EP06
    EP06 --> EP09[EP-09 Feedback]
    EP06 --> EP10[EP-10 MobileGIS]
    EP03 --> EP07[EP-07 Spatial/Stats]
    EP11[EP-11 DevOps/Pipeline] --> EP04
    EP11 --> EP06
```

## 7. Định nghĩa "Release Done"
- Tất cả Story trong release đạt DoD.
- Demo nghiệm thu với PO + stakeholder.
- Tài liệu API + vận hành cập nhật.
- Smoke test trên môi trường staging xanh.
