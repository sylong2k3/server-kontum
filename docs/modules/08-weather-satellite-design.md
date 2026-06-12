# 08 — Module Design: Thời tiết & Ảnh vệ tinh

## A. Thời tiết thời gian gần thực (EP-05)

### A.1 Mục tiêu
Hiển thị lớp nhiệt độ, lượng mưa, mây, và **animation gió dạng dòng chảy (windy streamlines)** trên WebGIS, đồng thời cung cấp dữ liệu thời tiết phục vụ mô hình cháy rừng.

### A.2 Nguồn dữ liệu
| Dữ liệu | Nguồn | Vai trò |
|---------|-------|---------|
| Raster nhiệt/mưa/mây | OpenWeatherMap | Tile raster overlay |
| Lưới gió | Open-Meteo grid | Vệt dòng chảy gió (streamlines) |
| Nhiệt/gió/ẩm/mưa | ERA5-Land (GEE) | Đầu vào FireRisk |

### A.3 Luồng xử lý
```mermaid
flowchart LR
    Cron[weather.job.js\nWEATHER_CRON 0 * * *] --> OWM[OpenWeather API]
    Cron --> OM[Open-Meteo grid]
    OWM --> Cache[(gis.weather_cache)]
    OM --> Cache
    Cache --> API[/api/v1/weather/*]
    API --> Web[WebGIS overlay + wind streamlines]
```

### A.4 API
- `GET /api/v1/weather/layers?type=temp|rain|cloud|wind` → URL tile raster.
- `GET /api/v1/weather/wind-grid?bbox=` → lưới `{lat,lng,u,v}` cho animation.
- `GET /api/v1/weather/point?lng=&lat=` → popup thời tiết tại điểm.

### A.5 Frontend (windy streamlines)
- Tham chiếu `kontum-windy-style-streamlines.html`: nội suy lưới gió theo khu vực, vệt dòng chảy liên tục giống Windy; popup click trực tiếp trên bản đồ.
- Đề xuất dùng `mapbox-gl` + lớp custom canvas (particle animation) đọc từ `/weather/wind-grid`.
- Fallback: khi API lỗi → dùng dữ liệu cache gần nhất + nhãn thời điểm.

### A.6 Lưu ý
- Cache theo giờ để giảm gọi API (hạn ngạch OpenWeather).
- Tách `observed_at` để FE biết độ mới dữ liệu.

---

## B. Ảnh vệ tinh & Google Earth Engine (EP-04)

### B.1 Mục tiêu
Cho phép Sở NN&MT tìm kiếm, xem, so sánh và khai thác ảnh Sentinel-2 phục vụ giám sát rừng; tính chỉ số NDVI/NDMI/NBR; phân loại đối tượng và tính diện tích.

### B.2 Kiến trúc tích hợp GEE
```mermaid
flowchart LR
    UI[WebGIS] --> API[/api/v1/satellite/*]
    API --> GEE[gee.client.js]
    GEE --> EE[Google Earth Engine]
    EE -->|tile url / map id| API
    API -->|metadata| PG[(gis.satellite_image)]
    API --> UI
```
- Auth GEE: service account + `ggeServiceKey.json` (gitignore).
- Trả **map tile URL** (GEE `getMapId`) để FE render trực tiếp; metadata lưu PostGIS.

### B.3 API
| Endpoint | Mô tả |
|----------|-------|
| `GET /satellite/search?bbox=&from=&to=&cloud=` | Liệt kê ảnh khả dụng |
| `GET /satellite/indices?index=NDVI&bbox=&date=` | Tile chỉ số + legend |
| `POST /satellite/compare` | So sánh 2 thời điểm (swipe + diff NDVI) |
| `POST /satellite/classify` | Phân loại theo ngưỡng → diện tích (ha) + GeoJSON |
| `GET /satellite/images` / `/images/public` | Ảnh đã lưu / công khai |

### B.4 Chỉ số (xem chi tiết ở `07-fire-risk-design.md` §3)
NDVI/NDMI/NBR tính bằng `normalizedDifference` trên các band Sentinel-2 (B8, B4, B11, B12).

### B.5 Phân loại & tính diện tích
- Phân loại đơn giản theo ngưỡng chỉ số (rừng/đất trống/nước…).
- Diện tích: `ee.Image.pixelArea()` + `reduceRegion` theo lớp.
- Xuất vector: `reduceToVectors` → GeoJSON → tải về hoặc lưu `gis.map_layers`.

### B.6 Hiệu năng & hạn ngạch
- Giới hạn bbox/diện tích mỗi yêu cầu để tránh timeout GEE.
- Cache `mapid` theo (index, bbox, date) trong thời gian ngắn.
- Job nặng (classify toàn tỉnh) chạy async + thông báo khi xong (WebSocket).

### B.7 Phân quyền
- `so_nnmt`: full khai thác. `ubnd_tinh`: xem/so sánh. `citizen`: chỉ ảnh `is_public`. `system_admin`: quản trị toàn bộ.
