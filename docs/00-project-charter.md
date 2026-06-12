# 00 — Project Charter (Hiến chương dự án)

## 1. Tầm nhìn sản phẩm (Product Vision)

> **Cho** các cơ quan quản lý nhà nước (UBND tỉnh, Sở NN&MT) và người dân tỉnh Kon Tum
> **Những người** cần giám sát tài nguyên rừng, môi trường và phòng chống cháy rừng theo thời gian gần thực
> **Hệ thống WebGIS/MobileGIS Kon Tum** là một nền tảng bản đồ số tích hợp
> **Cung cấp** dữ liệu không gian, ảnh vệ tinh, cảnh báo cháy rừng tự động và kênh phản ánh hiện trường
> **Không giống** các cổng bản đồ tĩnh hiện nay
> **Sản phẩm này** kết hợp dữ liệu vệ tinh (Sentinel-2, MODIS, NASA FIRMS) với mô hình nguy cơ cháy và dữ liệu hiện trường để ra cảnh báo sớm, có thể hành động.

## 2. Bối cảnh & Vấn đề

Kon Tum có diện tích rừng lớn, địa hình phức tạp, mùa khô kéo dài gây nguy cơ cháy rừng cao. Hiện trạng:
- Dữ liệu môi trường phân tán, cập nhật thủ công, thiếu trực quan không gian.
- Phát hiện cháy chậm, dựa nhiều vào báo cáo thủ công từ kiểm lâm.
- Người dân thiếu kênh chính thống để tra cứu và phản ánh vi phạm/hiện trạng.

## 3. Mục tiêu & Kết quả then chốt (OKR)

**Objective 1 — Cảnh báo cháy rừng sớm và chính xác.**
- KR1: Bản đồ nguy cơ cháy cập nhật tự động ≤ 1 lần/ngày, phủ 100% diện tích rừng tỉnh.
- KR2: Tích hợp điểm cháy NASA FIRMS với độ trễ ≤ 3 giờ.
- KR3: Gửi cảnh báo đẩy (push) tới MobileGIS khi nguy cơ ≥ Cấp 4.

**Objective 2 — Số hóa và trực quan hóa dữ liệu môi trường.**
- KR1: Quản lý ≥ 10 lớp dữ liệu bản đồ (ranh giới rừng, tiểu khu, trạm kiểm lâm…).
- KR2: Hỗ trợ import shapefile/GeoJSON và xuất API bản đồ.

**Objective 3 — Kết nối người dân & cơ quan.**
- KR1: Người dân gửi phản ánh kèm ảnh + tọa độ GPS.
- KR2: Quy trình xử lý phản ánh có trạng thái (mới → đang xử lý → đã xử lý).

## 4. Phạm vi (Scope)

### Trong phạm vi (In-scope)
- Backend API (Node.js/Express + PostGIS) — nền tảng đã có.
- WebGIS (bản đồ Mapbox/MapLibre, lớp dữ liệu, popup, thống kê).
- MobileGIS (xem bản đồ, GPS, chụp ảnh, gửi phản ánh, nhận push).
- Pipeline dữ liệu: GEE → GeoTIFF/GeoJSON → cronjob Node → PostGIS → API.
- Phân quyền 4 vai trò; CMS tin tức/văn bản/bản đồ PDF.

### Ngoài phạm vi (Out-of-scope) — giai đoạn 1
- Mô hình AI phân loại lớp phủ chuyên sâu (chỉ dùng chỉ số ngưỡng).
- Tích hợp cảm biến IoT thực địa (để pha 2).
- Thanh toán/giao dịch.

## 5. Các bên liên quan (Stakeholders) & Tác nhân

| Tác nhân | Role code | Vai trò chính |
|----------|-----------|---------------|
| Quản trị hệ thống | `system_admin` | Quản trị nền tảng, người dùng, dữ liệu, API, cấu hình |
| UBND tỉnh | `ubnd_tinh` | Giám sát điều hành, xem báo cáo, cảnh báo, thống kê |
| Sở NN&MT | `so_nnmt` | Nghiệp vụ chính: cập nhật dữ liệu, phân tích ảnh, giám sát rừng, dự báo cháy |
| Người dân | `citizen` | Tra cứu công khai, gửi phản ánh, cập nhật hiện trạng qua MobileGIS |

## 6. Giả định, Ràng buộc, Phụ thuộc

**Giả định:** Có tài khoản Google Earth Engine (service account), NASA FIRMS map key, OpenWeather key, ranh giới rừng từ Kiểm lâm.

**Ràng buộc kỹ thuật (theo `.env.example`):**
- DB: PostgreSQL + PostGIS. GeoServer chỉ bind nội bộ, không expose internet.
- Auth: JWT HS256, access 15m / refresh 30d.
- Cron: fire-risk hằng ngày (`0 2 * * *`), FIRMS mỗi 2 giờ, weather mỗi giờ.

**Phụ thuộc ngoài:** GEE (Sentinel-2, MODIS LST, ERA5-Land), NASA FIRMS, OpenWeatherMap, Firebase Cloud Messaging.

## 7. Rủi ro chính & Giảm thiểu

| ID | Rủi ro | Mức | Giảm thiểu |
|----|--------|-----|------------|
| R1 | Hạn ngạch/độ trễ GEE | Cao | Cache GeoTIFF, chạy cron off-peak, fallback dữ liệu gần nhất |
| R2 | Mây che ảnh Sentinel-2 | Trung bình | Lọc `CLOUDY_PIXEL_PERCENTAGE<20`, dùng median nhiều ảnh |
| R3 | Cảnh báo sai (false positive) | Cao | Đối chiếu FIRMS + xác minh hiện trường trước khi báo động đỏ |
| R4 | Tải bản đồ lớn gây chậm | Trung bình | Tile/vector tile, GeoServer cache, phân trang API |
| R5 | Lộ key dịch vụ | Cao | Lưu trong `.env`/secret store, file key trong `.gitignore` |

## 8. Tiêu chí thành công

- Cảnh báo cháy hoạt động end-to-end (GEE → DB → API → Web/Mobile).
- 4 vai trò phân quyền đúng đặc tả.
- WebGIS render ≥ 10 lớp dữ liệu mượt; MobileGIS gửi phản ánh thành công.
- Tài liệu kỹ thuật + vận hành đầy đủ để bàn giao.
