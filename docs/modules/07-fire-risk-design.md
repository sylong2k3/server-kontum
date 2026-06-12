# 07 — Module Design: Dự báo & Cảnh báo cháy rừng

> Module lõi (EP-06). Tổng hợp dữ liệu vệ tinh + thời tiết → chỉ số FireRisk → phân cấp 5 mức → đối chiếu điểm cháy thực tế (FIRMS) → cảnh báo Web/Mobile.

## 1. Mục tiêu & phạm vi
- Tính bản đồ **nguy cơ cháy** (dự báo) hằng ngày toàn tỉnh.
- Hiển thị **điểm cháy thực tế** (NASA FIRMS) gần thời gian thực.
- Cảnh báo ưu tiên khi *nguy cơ cao* trùng *điểm cháy thực tế*.
- Gửi cảnh báo qua WebSocket (Web) và FCM (Mobile).

## 2. Hai lớp cảnh báo (theo khuyến nghị nghiệp vụ)

| Lớp | Ý nghĩa | Nguồn | Tần suất |
|-----|---------|-------|----------|
| Nguy cơ cháy rừng | Dự báo dựa nhiệt/khô hạn/gió/ẩm/độ dốc | GEE (Sentinel-2, MODIS, ERA5) | 1 ngày/lần |
| Điểm cháy thực tế | Cháy đang hoạt động | NASA FIRMS (VIIRS ~375m, MODIS) | 1–3 giờ/lần |

## 3. Chỉ số đầu vào & công thức

| Chỉ số | Công thức | Ý nghĩa |
|--------|-----------|---------|
| NDVI | (NIR−RED)/(NIR+RED) = `(B8−B4)/(B8+B4)` | Sức khỏe thực vật |
| NDMI | (NIR−SWIR1)/(NIR+SWIR1) = `(B8−B11)/(B8+B11)` | Độ ẩm thực vật |
| NBR | (NIR−SWIR2)/(NIR+SWIR2) = `(B8−B12)/(B8+B12)` | Nguy cơ/vùng cháy |
| LST | MODIS `MOD11A1` ×0.02 −273.15 | Nhiệt độ bề mặt (°C) |
| Rainfall | ERA5-Land / CHIRPS | Mưa gần đây |
| Wind | ERA5-Land / OpenWeather | Hướng & tốc độ gió |

### Chỉ số tổng hợp (mô hình trọng số)
```
FireRisk = 0.30·LST_score + 0.25·Dryness_score + 0.20·Wind_score
         + 0.15·Rainfall_score + 0.10·Slope_score
```
> Mã GEE tham chiếu trong tài liệu nghiệp vụ dùng biến thể trọng số (LST 0.35, Dry 0.30, Veg 0.20, NBR 0.15). **Cấu hình trọng số nên đặt trong `fire_risk.config`** để hiệu chỉnh không cần sửa code.

## 4. Phân cấp 5 mức

| Cấp | Điều kiện | Màu | Hành động |
|-----|-----------|-----|-----------|
| 1 – Thấp | < 0.2 | `#00cc44` Xanh | Theo dõi |
| 2 – Trung bình | 0.2–0.4 | `#ffff00` Vàng | Theo dõi tăng cường |
| 3 – Cao | 0.4–0.6 | `#ff9900` Cam | Chuẩn bị lực lượng |
| 4 – Rất cao | 0.6–0.8 | `#ff0000` Đỏ | Cảnh báo + push mobile |
| 5 – Nguy hiểm | > 0.8 | `#800000` Tím/đỏ đậm | Báo động + kiểm tra thực địa |

## 5. Kiến trúc xử lý

```mermaid
flowchart TB
    subgraph GEE[Google Earth Engine]
        S2[Sentinel-2: NDVI/NDMI/NBR]
        MODIS[MODIS LST]
        ERA5[ERA5-Land: gió/mưa/ẩm]
    end
    DEM[DEM SRTM: độ dốc]
    GEE --> EXP[Export GeoTIFF/GeoJSON]
    DEM --> EXP
    EXP --> JOB1[fire-risk.job.js\nFIRE_RISK_CRON 0 2 * * *]
    JOB1 --> CALC[Tính FireRisk + phân cấp]
    CALC --> PG1[(fire.forest_fire_warning)]

    FIRMS[NASA FIRMS] --> JOB2[firms.job.js\nFIRMS_CRON 0 */2 * * *]
    JOB2 --> DEDUP[Dedupe + lưu]
    DEDUP --> PG2[(fire.active_fire_point)]

    PG1 --> CORR[Spatial join: nguy cơ cao + FIRMS gần]
    PG2 --> CORR
    CORR --> PRIO[priority = high]
    PRIO --> API[/api/v1/fire-risk/latest]
    PRIO --> WS[WebSocket fire-alerts]
    PRIO --> FCM[Push FCM theo vị trí]
    API --> WEB[WebGIS Mapbox]
    FCM --> MOB[MobileGIS]
```

## 6. Pipeline GEE (các bước, tham chiếu mã nghiệp vụ)

> **Hai dạng đầu ra song song (xem hướng dẫn doc 13):**
> - **Raster GeoTIFF** (FireRisk liên tục/risk_level) → lưu **filesystem** `/data/geotiff/fire-risk/YYYY-MM-DD.tif` → GeoServer **ImageMosaic** (time dimension) → WMS cho Mapbox. **Không vào PostGIS.**
> - **Vector polygon** (vùng nguy cơ + thuộc tính chỉ số) → **PostGIS** `fire.forest_fire_warning` → WFS/MVT + dùng cho đối chiếu FIRMS.

1. Lấy vùng nghiên cứu (FeatureCollection ranh giới Kon Tum, asset GEE — biến `GEE_REGION_ASSET`).
2. Lọc Sentinel-2 `COPERNICUS/S2_SR_HARMONIZED`, `CLOUDY_PIXEL_PERCENTAGE<20`, median, clip.
3. Tính NDVI/NDMI/NBR (`normalizedDifference`).
4. Lấy MODIS `MOD11A1` `LST_Day_1km`, đổi °C.
5. Tính các *_score* và `FireRisk`.
6. Phân cấp `risk_level` 1–5 (`expression`).
7. Vectorize (`reduceToVectors`) → GeoJSON polygon kèm thuộc tính chỉ số; đồng thời export raster (`Export.image`) GeoTIFF.
8. Node job: vector → UPSERT PostGIS `fire.forest_fire_warning`; GeoTIFF → lưu filesystem + harvest vào GeoServer ImageMosaic (doc 13 §5).

> Auth GEE: service account (`GEE_SERVICE_ACCOUNT`) + key file `ggeServiceKey.json` (đã trong `.gitignore`). Client đề xuất: thư viện `@google/earthengine` hoặc gọi qua dịch vụ Python phụ trợ nếu cần API đầy đủ.

## 7. Đối chiếu FIRMS (logic ưu tiên)
```sql
-- Gắn priority cao cho polygon nguy cơ >= 4 có điểm FIRMS trong 1km
UPDATE fire.forest_fire_warning w
SET priority = 'high'
WHERE w.risk_level >= 4
  AND EXISTS (
    SELECT 1 FROM fire.active_fire_point p
    WHERE p.acq_date >= NOW()::date - INTERVAL '1 day'
      AND ST_DWithin(w.geom::geography, p.geom::geography, 1000)
  );
```

## 8. Thiết kế kỹ thuật trong codebase (bám pattern hiện có)

```
src/
├── jobs/
│   ├── fire-risk.job.js     # cron tính nguy cơ (FIRE_RISK_CRON)
│   └── firms.job.js         # cron ingest FIRMS (FIRMS_CRON)
├── utils/
│   ├── gee.client.js        # khởi tạo & gọi GEE
│   └── firms.client.js      # gọi FIRMS API (FIRMS_MAP_KEY)
├── repositories/
│   └── fire.repository.js   # CRUD fire.* + spatial join
├── services/
│   └── fire-risk.service.js # logic tổng hợp, phân cấp, ưu tiên
├── controllers/
│   └── fire-risk.controller.js
├── validators/
│   └── fire-risk.validator.js
└── routes/
    └── fire-risk.routes.js   # bỏ comment trong routes/index.js
```

**Chống chạy trùng cron khi scale:** chỉ worker có `CLUSTER_WORKER_ID === '0'` (hoặc advisory lock `pg_try_advisory_lock`) mới chạy job.

## 9. Hợp đồng API (đã định nghĩa ở `06-api-design.md`)
- `GET /api/v1/fire-risk/latest` → GeoJSON nguy cơ.
- `GET /api/v1/fire-risk/points/active` → điểm FIRMS.
- `POST /api/v1/fire-risk/subscribe` → đăng ký push theo GPS.
- `POST /api/v1/fire-risk/recompute` (admin) → chạy lại pipeline.

## 10. Hiển thị Mapbox (mẫu)
```js
map.addSource('fire-risk', { type: 'geojson', data: '/api/v1/fire-risk/latest' });
map.addLayer({
  id: 'fire-risk-layer', type: 'fill', source: 'fire-risk',
  paint: {
    'fill-color': ['match', ['get', 'risk_level'],
      1, '#00cc44', 2, '#ffff00', 3, '#ff9900', 4, '#ff0000', 5, '#800000', '#cccccc'],
    'fill-opacity': 0.55
  }
});
```

### Popup cảnh báo (nội dung)
```
Cấp cảnh báo: Rất cao        Chỉ số nguy cơ: 0.78
Nhiệt độ bề mặt: 39.5°C      NDMI: 0.12
Gió: 18 km/h                 Mưa 7 ngày: thấp
Cập nhật: 24/05/2026
Khuyến nghị: Kiểm tra thực địa / gửi cảnh báo MobileGIS
```

## 11. Lịch cập nhật (cron, từ `.env`)
| Dữ liệu | Biến cron | Mặc định |
|---------|-----------|----------|
| FIRMS điểm cháy | `FIRMS_CRON` | `0 */2 * * *` |
| Thời tiết | `WEATHER_CRON` | `0 * * * *` |
| Bản đồ nguy cơ | `FIRE_RISK_CRON` | `0 2 * * *` |

## 12. Kiểm thử & nghiệm thu (DoD riêng module)
- Unit test công thức score & phân cấp (biên 0.2/0.4/0.6/0.8).
- Test dedupe FIRMS (không double khi cron chạy lại).
- Test spatial join priority với fixture polygon + point.
- Integration: `/fire-risk/latest` trả GeoJSON hợp lệ, FE render đúng màu.
- Test cron idempotent (chạy 2 lần không nhân đôi dữ liệu).
- Smoke: pipeline end-to-end với vùng nhỏ (1 huyện) trước khi bật toàn tỉnh.

## 13. Rủi ro & xử lý
- **Hạn ngạch GEE:** chạy off-peak, cache, fallback dữ liệu ngày trước; cảnh báo ops khi job fail.
- **Mây dày:** tăng cửa sổ ngày median; đánh dấu "dữ liệu cũ" trên popup.
- **False positive:** không tự động báo động cấp cao nếu không có FIRMS xác nhận; gắn cờ "cần xác minh".
- **Độ lệch trọng số:** lưu cấu hình trọng số + ghi log phiên bản mô hình theo `warning_time`.
