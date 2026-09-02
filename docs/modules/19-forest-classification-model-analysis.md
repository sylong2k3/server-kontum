# Phân tích sai lệch mô hình phân loại rừng hiện tại

> Phạm vi: pipeline 11 lớp đang chạy trong `forest-classification.pipeline.js`
> (`runRfClassification` chế độ lite) + orchestrator
> `forest-classification.service.js` (admin snapshot dùng chung lite mode).
> Kết quả đối chiếu do nhóm dự án cung cấp, log server đến 2026-07-24.
>
> File song hành thiết kế: [18-forest-classification-design.md](18-forest-classification-design.md).

## 1. Kết luận ngắn

Pipeline không sai chủ yếu ở diện tích vùng nghiên cứu. Kết quả 963.915 ha chỉ
thiếu khoảng 3.502 ha (0,36%) so với diện tích tự nhiên 967.417,11 ha. Sai lệch
lớn nằm ở việc phân bổ pixel giữa các lớp.

Các dấu hiệu nổi bật:

- Cây công nghiệp dư khoảng 223.850 ha.
- Rừng lá rộng thường xanh thiếu khoảng 212.228 ha.
- Tổng lớp rừng 3-8 đạt khoảng 492.018 ha, thấp hơn diện tích có rừng chính thức
  124.177,94 ha (20,15%).
- Tổng rừng tự nhiên lớp 3-7 đạt khoảng 411.062 ha, thấp hơn số chính thức
  141.288,72 ha (25,58%).
- Log chỉ ghi nhận 10 lớp có diện tích trong một số lần chạy, dù schema có 11
  lớp. Ít nhất một lớp không có pixel hoặc không có đủ mẫu để xuất hiện.

Mô hình hiện tại vì vậy phù hợp làm bản đồ thử nghiệm và theo dõi kỹ thuật,
chưa đủ căn cứ để công bố là bản đồ hiện trạng rừng hoặc số liệu kiểm kê.

## 2. Benchmark được sử dụng

Mốc gần nhất là hiện trạng rừng tại ngày 31/12/2024 theo Quyết định
99/QĐ-UBND ngày 28/02/2025:

| Chỉ tiêu | Diện tích |
|---|---:|
| Diện tích tự nhiên | 967.417,11 ha |
| Diện tích có rừng | 616.195,94 ha |
| Rừng tự nhiên | 552.350,72 ha |
| Rừng trồng | 63.845,22 ha |
| Tỷ lệ che phủ | 63,69% |

Benchmark quy đổi 11 lớp có một số giả định nghiệp vụ. Đặc biệt, rừng hỗn giao
gỗ - tre nứa được gộp vào lớp 7 vì schema hiện tại không có lớp riêng; cao su
được tính vào cây công nghiệp thay vì rừng trồng. Do đó bảng này dùng để phát
hiện sai lệch lớn, không phải confusion matrix chính thức.

| ID | Lớp | Benchmark | Mô hình | Chênh lệch |
|---:|---|---:|---:|---:|
| 0 | Đất khác | 58.775,00 | 4.260 | -54.515,00 |
| 1 | Cây công nghiệp | 115.311,10 | 339.161 | +223.849,90 |
| 2 | Đất nông nghiệp | 181.135,90 | 77.964 | -103.171,90 |
| 3 | Rừng hỗn giao lá rộng, lá kim | 15.881,09 | 92.144 | +76.262,91 |
| 4 | Rừng lá rộng thường xanh | 448.516,54 | 236.289 | -212.227,54 |
| 5 | Rừng lá kim | 13.336,91 | 51.626 | +38.289,09 |
| 6 | Rừng lá rộng rụng lá | 515,55 | 9.219 | +8.703,45 |
| 7 | Tre nứa và hỗn giao gỗ - tre nứa | 74.100,63 | 21.784 | -52.316,63 |
| 8 | Rừng trồng không tính cao su | 23.838,65 | 80.956 | +57.117,35 |
| 9 | Sông, suối, hồ | 9.035,00 | 10.129 | +1.094,00 |
| 10 | Trảng cỏ, cây bụi | 26.970,74 | 40.383 | +13.412,26 |

## 3. Pipeline thực tế đang chạy

Log server cho thấy admin snapshot đang dùng cấu hình lite (khớp
`model_params: { version: 'v3-lite', mode: 'lite' }` lưu trong DB):

```text
[FOREST-CLS-RF-LITE#2026-MM] ▶ RF quotas (LITE): hasGT=false input=0 dataset=0
    threshold=30 inputTest=10 scale=100m trees=80
[FOREST-CLS-RF-LITE#2026-MM] ▶ Dataset pseudo-label: SKIPPED (liteMode)
    — threshold labels only
[FOREST-CLS-RF-LITE#2026-MM] ▶ GETINFO OOB accuracy (forces sampling
    + RF training on EE): async getInfo(callback), timeout=600000ms
[FOREST-CLS-RF-LITE#2026-MM] ▶ OOB accuracy — <giá trị>%
```

Nghĩa là Random Forest chỉ học từ các nhãn do chính bộ ngưỡng phổ, địa hình và
mùa vụ tạo ra. Dynamic World, ESA WorldCover và JRC không tham gia vào tập
nhãn huấn luyện; ground truth thực địa chỉ được dùng khi có row active trong
`forest.forest_gt_zones`/`forest.forest_gt_points` (migration 033) nằm trong
cửa sổ 180 ngày (`FC_GT_WINDOW_DAYS`).

Nguồn GT ưu tiên **inline GeoJSON** (query PostGIS) hơn `groundTruthAssetId`
GEE. Nếu migration 033 chưa chạy, pipeline log warning
`Ground truth SKIPPED (42P01)` và fallback về `hasGT=false` mà không kill run.

## 4. Nguyên nhân sai lệch

### 4.1 Không có ground truth độc lập

`hasGT=false` làm quota ground truth bằng 0. Toàn bộ tập train là pseudo-label.
Mô hình có thể học rất tốt các ngưỡng sai và vẫn cho OOB cao. OOB trong trường
hợp này đo khả năng tái tạo pseudo-label, không đo độ đúng với hiện trạng rừng.

### 4.2 Admin đang chạy lite mode threshold-only

Để tránh timeout, cả admin lẫn on-demand `/satellite/classified` đều dùng
`liteMode: true` — 80 cây, 30 mẫu/lớp ở 100m và bỏ toàn bộ dataset
label. Đây là thay đổi lớn so với thiết kế full: 200 cây, 100 mẫu/lớp ở
30m, kết hợp Dataset + Threshold. Việc giảm chất lượng đầu vào giải thích
vì sao ranh giới chạy nhanh nhưng phân bố lớp bị lệch mạnh.

Full mode vẫn còn trong pipeline (`FC_LITE_USE_DATASET_LABELS=true` để bật
Dataset trong lite; sửa `liteMode: false` trong service để chạy full). Không
ai đang trigger vì cron trước kia liên tục fail ở stage OOB
`getInfo(callback)` với timeout 5 phút cũ. Timeout OOB giờ tách riêng
`FC_OOB_TIMEOUT_MS = 600000` (10 phút), nhưng chưa test full end-to-end.

### 4.3 Nhầm lẫn phổ giữa lớp 1, 3, 4, 5 và 8

Rừng thường xanh, cao su/cây công nghiệp, rừng trồng và một số kiểu rừng hỗn
giao đều có NDVI cao, biên độ mùa thấp và phản xạ SWIR gần nhau. Các threshold
hiện tại chồng lấn đáng kể. Priority mosaic cho lớp xuất hiện sau ghi đè lớp
trước, nên lỗi ở mask hoặc thứ tự ưu tiên được truyền thẳng sang mẫu train.

Cặp sai lệch gần đối xứng giữa lớp 1 (+223.850 ha) và lớp 4 (-212.228 ha) là
dấu hiệu mạnh cho thấy phần lớn rừng thường xanh đang bị nhận thành cây công
nghiệp.

### 4.4 Schema 11 lớp chưa khớp hệ thống kiểm kê

Kiểm kê có rừng hỗn giao gỗ - tre nứa nhưng schema chỉ có rừng tre nứa và rừng
hỗn giao lá rộng - lá kim. Khoảng 52.627 ha không có nhãn đích tương ứng nên bị
ép sang lớp khác. Cao su cũng có cách tính khác nhau giữa lớp cây công nghiệp
và rừng trồng, làm benchmark và tổng rừng dễ bị đếm trùng hoặc bỏ sót.

### 4.5 Tổng rừng trong code đang gồm cả cây công nghiệp

`FOREST_CLASS_IDS` hiện là `[1, 3, 4, 5, 6, 7, 8]`. Việc tính class 1 là rừng
làm tỷ lệ rừng trên admin/client bị phóng đại. Theo benchmark đang dùng, tổng
rừng cần đối chiếu là class 3-8; riêng cao su phải có quy tắc nghiệp vụ rõ ràng
trước khi cộng vào rừng trồng.

Đây là lỗi semantic của chỉ số hiển thị, tách biệt với lỗi phân loại pixel.

### 4.6 Snapshot theo tháng nhưng feature image theo năm

`buildFeatureImage(year, ...)` dùng cùng composite tháng 1-12, mùa khô 1-4 và
mùa mưa 8-11 cho mọi snapshot trong cùng một năm. Tham số `month` không đi vào
feature image. Vì vậy các kỳ 2026-05, 2026-06 và 2026-07 về bản chất dùng cùng
một mô hình theo năm, không phải ba mô hình theo tháng. Điều này giải thích các
kết quả gần như giống nhau giữa các tháng và làm comparison theo tháng kém ý
nghĩa.

### 4.7 Scale thống kê và raster publish quá thô

Area stats đang chạy ở **200m** (hardcode `AREA_SCALE_M = 200` trong
`forest-classification.service.js`, override `FC_AREA_STATS_SCALE_M=60`
default trong config). Raster download/publish mặc định ở **500m**
(`FC_DOWNLOAD_SCALE_M`, đồng bộ với fire-risk để tránh GEE materialize
memory limit khi visualize 11-class palette + clip theo tỉnh).

Scale này giúp pipeline ổn định nhưng làm mất các mảng nhỏ và ranh giới hẹp.
Nó có thể gây sai số diện tích cục bộ, nhưng không đủ để giải thích chênh lệch
hơn 200.000 ha giữa lớp 1 và lớp 4. Nguyên nhân chính vẫn là nhãn train và
định nghĩa lớp.

## 5. OOB, test accuracy và test kappa được tính như thế nào

Admin snapshot bật cả 3 flag (chỉ OOB thực sự chạy vì `computeTestMetrics: false`):

```js
runRfClassification(year, region, geom, {
    liteMode:           true,   // skip DW+WC+JRC
    computeOob:         true,   // classifier.explain().getInfo(callback)
    computeTestMetrics: false,  // chỉ bật khi có holdout GT đủ tin cậy
});
```

**OOB accuracy**:
```text
oobAccuracy = (1 - outOfBagErrorEstimate) * 100
```
Giá trị đọc từ `classifier.explain()` bằng `getInfo(callback)` bất đồng bộ.
Chỉ dictionary chứa `outOfBagErrorEstimate` được tải về, không tải cây quyết
định hoặc toàn bộ tập mẫu. Timeout riêng `FC_OOB_TIMEOUT_MS`, mặc định 600000
ms (10 phút, dài hơn `GEE_TIMEOUT_MS = 300000`).

Endpoint tương tác `/satellite/classified` vẫn bỏ OOB (`skipStats: true`) để
giữ thời gian phản hồi ~15-30s cho getMapId.

**Test accuracy + kappa** (migration 027 đã tạo column):
```text
matrix          = inputTestSamples.classify(classifier).errorMatrix('class','classification',classOrder)
testAccuracyPct = matrix.accuracy() * 100
testKappa       = matrix.kappa()
```
Chỉ chạy khi `hasGT === true` VÀ `computeTestMetrics === true` VÀ
`inputTestSamples.size() > 0`. Column `forest.forest_snapshots.test_accuracy`
NUMERIC(5,2) + `test_kappa` NUMERIC(6,3) hiện luôn NULL vì flag đang tắt.

Trước thay đổi này, admin truyền `skipStats=true` và gán cả `oobPct=null`,
vì vậy cột OOB luôn trống. Việc tách 3 flag (`computeOob` / `computeTestMetrics`
/ `skipStats`) cho phép admin lấy diagnostic OOB mà không kéo thêm holdout
metrics chưa đủ tin cậy.

### Cách đọc OOB

- OOB cao, không có GT: chỉ kết luận RF nhất quán với pseudo-label.
- OOB thấp: feature hoặc pseudo-label không tách được các lớp; cần xem lại mẫu.
- OOB không thay thế precision/recall từng lớp, confusion matrix và spatial
  holdout.
- Không dùng OOB để khẳng định tỷ lệ che phủ hoặc diện tích kiểm kê.

## 6. Thứ tự xử lý đề xuất

1. Chốt quy tắc nghiệp vụ cho cao su và sửa `FOREST_CLASS_IDS`
   (`server/src/configs/forest-classification.js:67`); không để class 1
   mặc định được tính hoàn toàn là rừng. Ảnh hưởng notification
   `_notifyForestClassificationCompleted` và `sumForestByClass` trong
   comparison payload.
2. Nạp ground truth đủ 11 lớp qua endpoint
   `/forest-classification/ground-truth/{zones,points}` (migration 033),
   tách train/test theo không gian thay vì random point gần nhau (hiện dùng
   `randomColumn` seed `rfSeed + 101`).
3. Đổi feature window theo ngày cuối kỳ; snapshot tháng không được dùng cùng
   composite cả năm. Cần refactor `buildFeatureImage(year, region)` thành
   `buildFeatureImage(year, month, region)`.
4. Bật `computeTestMetrics: true` trong `runRfClassification` call của
   `forest-classification.service.js:321` khi GT holdout đủ mẫu — cột
   `test_accuracy`/`test_kappa` đã sẵn sàng từ migration 027.
5. Chạy batch full hoặc materialize feature/sample asset bất đồng bộ để bật
   lại Dataset labels mà không giữ HTTP request nhiều phút. Có thể set
   `FC_LITE_USE_DATASET_LABELS=true` cho lần thử nghiệm A/B.
6. Xuất confusion matrix, precision, recall, F1 và số mẫu từng lớp. Cảnh báo
   nếu một lớp không có mẫu hoặc không xuất hiện trong raster (mở rộng
   `sample_quotas` JSONB hoặc thêm bảng mới).
7. Hiệu chỉnh threshold theo vùng sinh thái và bổ sung lớp hỗn giao gỗ -
   tre nứa hoặc công bố rõ quy tắc ánh xạ vào 11 lớp.
8. Chỉ giảm scale area (200m→60m) / publish (500m→100m) sau khi phân bố lớp
   ở 100-200m đã đạt benchmark; tăng độ phân giải không sửa được nhãn sai.

## 7. Kiểm tra sau triển khai

Sau khi chạy lại `POST /api/v1/forest-classification/refresh` (body
`{ year, month }`, permission `forest_classification.manage`), log cần có:

```text
[FOREST-CLS-RF-LITE#YYYY-MM] ▶ GETINFO OOB accuracy (forces sampling + RF training on EE)
[FOREST-CLS-RF-LITE#YYYY-MM] ✓ GETINFO OOB accuracy — 5432ms
[FOREST-CLS-RF-LITE#YYYY-MM] ▶ OOB accuracy — <giá trị>%
```

Kiểm tra:

- `forest.forest_snapshots.oob_accuracy` (column từ migration 020)
- `forest.forest_snapshots.sample_quotas` (JSONB từ migration 027 —
  xác nhận `inputQuota=0` khi hasGT=false, `thresholdQuota=30` cho lite)
- `forest.forest_snapshots.gt_zone_count`, `gt_point_count`, `gt_window_days`
  (migration 033)
- `forest.forest_snapshots.gee_download_url` không NULL → auto-ingest sẽ
  enqueue raster-ingest job
- Sau vài phút: `forest.forest_snapshots.geoserver_layer` được back-link
  bởi worker → snapshot xuất hiện trên `/published-history`

Snapshot cũ vẫn có OOB null (chạy trước 2026-05); chỉ lần chạy mới mới có
giá trị. Snapshot đã completed nhưng thiếu `gee_download_url` (getDownloadURL
timeout): chạy lại `POST /refresh` cùng year/month để tạo URL rồi
`POST /snapshots/:id/publish-raster`.

## 8. Nguồn tham chiếu

- [UBND tỉnh Kon Tum: hiện trạng rừng năm 2024, tỷ lệ che phủ 63,69%](https://www.kontum.gov.vn/pages/detail/54922/Nam-2024-ty-le-che-phu-rung-tren-toan-tinh-dat-6369.html)
- [Google Earth Engine: `ee.Classifier.explain()`](https://developers.google.com/earth-engine/apidocs/ee-classifier-explain)
- [Google Earth Engine: `ee.Dictionary.getInfo()`](https://developers.google.com/earth-engine/apidocs/ee-dictionary-getinfo)
- [Google Earth Engine: supervised classification và validation](https://developers.google.com/earth-engine/guides/classification)
- File thiết kế song hành: [18-forest-classification-design.md](18-forest-classification-design.md)
- Migration schema: `020_satellite.sql`, `021_forest_classification_logs.sql`,
  `023_forest_data_historical.sql`, `027_forest_classification_v3_metrics.sql`,
  `033_forest_ground_truth.sql`, `034_forest_download_url.sql`,
  `036_clear_fire_risk_forest_classification_history.sql`

