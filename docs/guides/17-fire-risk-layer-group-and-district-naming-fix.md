# Fix: nhóm layer cháy rừng/phân loại rừng + tên huyện thật (28/07/2026)

> Bối cảnh: layer cháy rừng theo huyện đang hiển thị tên **"Huyện 1"…"Huyện 10"** và
> rơi vào nhóm "Khác" (không tên) trong layer picker mobile, đứng lẫn phía trên các
> nhóm "Lớp phủ"/"Nhiệt độ bề mặt". Tài liệu này ghi lại nguyên nhân, cách chia layer
> theo huyện/toàn tỉnh đã có sẵn trong kiến trúc, và 2 bug đã sửa.

## 1. Kiến trúc chia "theo huyện" / "toàn tỉnh" — đã có chủ đích, không phải thiếu

Xem thiết kế gốc ở [07-fire-risk-design.md](../modules/07-fire-risk-design.md); tài
liệu đó mô tả kiến trúc ban đầu (Sprint 0), pipeline thật hiện tại (v8.3,
`fire-risk.service.js`) đã tiến hoá thêm phần dưới đây.

**Theo huyện** = 10 layer GeoServer riêng biệt (`fire_risk_KT-1_...` .. `fire_risk_KT-10_...`,
publish qua `raster-ingest.service.js`), mỗi huyện 1 raster ~150m/pixel. Đây là layer
WMS bền, client render như mọi layer raster khác qua `GET /map/layers`.

**Toàn tỉnh** = **cố tình KHÔNG** publish thành 1 raster GeoTIFF riêng. Migration
[`040_reset_fire_forest_v2.sql`](../../src/database/migrations/040_reset_fire_forest_v2.sql)
ghi rõ lý do: export raster cho cả tỉnh từng vượt giới hạn bộ nhớ/timeout của GEE.
Thay vào đó server trả 2 thứ qua `GET /fire-risk/latest`:
1. `snapshot.geeTileUrl` — tile Earth Engine trực tiếp (`ee.data.getMapId`), phủ toàn
   tỉnh trong 1 URL, không qua GeoServer, tự hết hạn theo phiên (không publish tĩnh).
2. `provinceSummary` — tổng hợp Σ diện tích 10 huyện
   (`aggregateProvinceFromDistricts()` trong `fire-risk.service.js`).

**Không đề xuất publish raster toàn tỉnh mới** — hướng đó đã bị loại bỏ có chủ đích.
Nếu FE cần xem "toàn tỉnh" trên bản đồ dạng WMS mà không sửa server: bật cùng lúc cả
10 layer huyện — chúng tile khít bbox và dùng chung 1 bảng màu risk cố định
(`RISK_LEVEL_VIZ`, 5 cấp) nên ghép lại không lệch màu ở ranh giới.

## 2. Bug #1 — tên huyện luôn là "Huyện 1".."Huyện 10"

**Triệu chứng**: thấy ở cả 3 nơi — `GET /map/layers` (`name_vi`), GeoServer WMS
`<Title>`, và `GET /fire-risk/latest` (`districtStats[].name`).

**Nguyên nhân**: `src/utils/gee-satellite.util.js` đọc file
`data/RanhGioiHuyen_Polygon.geojson` nhưng chỉ tìm property theo schema GADM v2
(`NAME_VN`, `ADM2_NAME`, `NAME_2`, `VARNAME_2`, `NAME_EN`) — comment hàm mô tả sai
schema thật. File thật dùng property tiếng Việt: `ten_huyen`, `ten`, `ma_huyen`,
`loai`. Không property nào khớp → luôn rơi về fallback `` `Huyện ${i+1}` ``.

**Fix** (2 vị trí: `_tryLoadDistrictsFile()` và `getKonTumDistrictsGeoJson()`):
thêm `ten_huyen`/`ten`/`ma_huyen`/`loai` vào ĐẦU chain fallback, ưu tiên hơn tên GADM
(vẫn giữ GADM/FAO làm dự phòng nếu sau này đổi file nguồn).

```js
// Trước
const rawName = p.NAME_VN || p.ADM2_NAME || p.NAME_2 || p.VARNAME_2 || p.NAME_EN || null;
const rawCode = p.CODE_2002 ?? p.ADM2_CODE ?? p.ID_2 ?? p.OBJECTID ?? null;

// Sau
const rawName = p.ten_huyen || p.ten || p.NAME_VN || p.ADM2_NAME || p.NAME_2 || p.VARNAME_2 || p.NAME_EN || null;
const rawCode = p.ma_huyen ?? p.CODE_2002 ?? p.ADM2_CODE ?? p.ID_2 ?? p.OBJECTID ?? null;
// + p.loai thêm vào chain TYPE_2
```

Đã verify bằng cách chạy thử logic trên file thật — mapping đúng thứ tự file
(cũng khớp 100% với suy luận bbox đối chiếu layer `ranh_gioi_huyen`):

| Mã cũ (fallback) | Mã mới (`ma_huyen`) | Tên huyện thật |
|---|---|---|
| KT-1  | 608 | Thành phố Kon Tum |
| KT-2  | 610 | Huyện Đắk Glei |
| KT-3  | 611 | Huyện Ngọc Hồi |
| KT-4  | 612 | Huyện Đắk Tô |
| KT-5  | 613 | Huyện Kon Plông |
| KT-6  | 614 | Huyện Kon Rẫy |
| KT-7  | 615 | Huyện Đắk Hà |
| KT-8  | 616 | Huyện Sa Thầy |
| KT-9  | 617 | Huyện Tu Mơ Rông |
| KT-10 | 618 | Huyện Ia H' Drai |

**Lưu ý vận hành**: `district_code`/`ADM2_CODE` đổi từ quy ước `"KT-N"` sang mã huyện
thật (`"608".."618"`) — đã kiểm tra không nơi nào khác trong server hardcode format
`"KT-"` (chỉ dùng làm fallback sinh mã khi thiếu dữ liệu thật, đúng như migration 040
vốn định dùng `ADM2_CODE` thật). Không có `CHECK` constraint nào ràng buộc format cột
`district_code` (`VARCHAR(32)` tự do).

## 3. Bug #2 — `layer_group` không được gán khi auto-ingest

**Triệu chứng**: mọi layer `category='fire_risk_district'` (và tương tự
`'forest_district'`) có `layer_group = null` trong `gis.layer_registry` → rơi vào
nhóm "Khác" (group key rỗng, sort trước hết) ở layer picker mobile thay vì có mục
riêng như "Lớp phủ"/"Nhiệt độ bề mặt".

**Nguyên nhân**: `_autoIngestDistrict()` ở cả `fire-risk.service.js` và
`forest-classification.service.js` gọi `raster-ingest.service.js#enqueue()` với
`category` nhưng không có `layer_group`, dù cột này đã được `_upsertRasterLayer()`
đọc sẵn (`params.layer_group`) và validator (`raster-ingest.validator.js`) đã hỗ trợ.

**Cạm bẫy khi sửa**: `enqueue()` chỉ destructure
`{ sourceUrl, layerCode, nameVi, nameEn, isPublic, category, requestParams, user, lang }`
— thêm `layerGroup` làm tham số top-level sẽ bị **âm thầm bỏ qua** (không lỗi, không
warning). Cách đúng: nhét vào BÊN TRONG object `requestParams`, vì `enqueue()` spread
nguyên `requestParams` vào cột JSONB `job.request_params` không lọc field, và
`_upsertRasterLayer()` đọc thẳng `job.request_params.layer_group`.

```js
// fire-risk.service.js _autoIngestDistrict() — SAI (bị bỏ qua):
await ingestSvc.enqueue({
    ...
    category:   'fire_risk_district',
    layerGroup: 'chay_rung',       // ❌ enqueue() không nhận field này
    requestParams: { ... },
});

// ĐÚNG:
await ingestSvc.enqueue({
    ...
    category:   'fire_risk_district',
    requestParams: {
        ...
        layer_group: 'chay_rung', // ✅ snake_case, nằm trong requestParams
    },
});
```

Áp dụng tương tự cho `forest-classification.service.js` với
`layer_group: 'phan_loai_rung'`.

## 4. Phía mobile (`kontum_moblie`) — nhãn nhóm mới

Đã thêm 2 nhóm mới vào `layerGroupLabel()`
(`lib/features/map/presentation/layer_visuals.dart`) + l10n
(`lib/l10n/app_vi.arb`, `app_en.arb`):

| `layer_group` code | Nhãn VI | Nhãn EN |
|---|---|---|
| `chay_rung` | Cảnh báo cháy rừng | Forest fire risk |
| `phan_loai_rung` | Phân loại rừng | Forest classification |

Icon/màu (lửa 🔥 cho `chay_rung`) đã tự khớp từ trước qua regex có sẵn trong
`_rules` (`chay rung|diem chay|nguy co chay|fire`) — không cần thêm rule riêng.
Đã chạy `flutter gen-l10n` + `flutter analyze` sạch.

## 5. Ảnh hưởng & lưu ý vận hành

- Fix chỉ có hiệu lực từ **lần phân tích tiếp theo** (cron `FIRE_RISK_CRON` hoặc admin
  gọi `POST /fire-risk/refresh`). **Không backfill** 10 dòng dữ liệu đã có trong
  `gis.layer_registry`/GeoServer từ trước ngày 28/07/2026 (snapshot cũ vẫn giữ tên
  "Huyện N" + `layer_group=null`) — mỗi lần chạy tạo layer/snapshot mới (layer code
  gắn `dateTag` + `snapshot.id`), không phải upsert đè lên layer cũ.
- Không tự trigger chạy lại phân tích để áp dụng ngay cho dữ liệu hôm nay — việc đó
  tốn GEE quota thật và gửi notification thật tới role `system_admin`/`so_nnmt`/
  `ubnd_tinh` (`_notifyFireRiskCompleted`). Quyết định: để cron tự chạy theo lịch.
- Nếu sau này kiểm tra thấy `/fire-risk/latest` vẫn trả "Huyện N": kiểm tra
  `computedAt`/`analysisDate` của snapshot mới nhất trước khi kết luận fix không hoạt
  động — rất có thể cron chưa chạy lại kể từ ngày sửa.
