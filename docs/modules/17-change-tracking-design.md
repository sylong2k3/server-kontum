# 17 — Module Design: Đo đạc thực địa — ghi nhận biến đổi khu vực

> Phạm vi (chốt 2026-07-13): cán bộ Sở NN&MT ra hiện trường, bật định vị GPS, đi men
> theo ranh giới khu vực biến đổi để đo diện tích, chụp ảnh, ghi chú biến đổi (từ loại
> đất gì sang gì), rồi **gửi báo cáo** → **Admin tiếp nhận & xác thực** → thông báo kết
> quả cho Sở + UBND tỉnh. Mỗi khu vực có thể **đo nhiều lần theo thời gian** để theo dõi
> diễn tiến biến đổi.
>
> KHÔNG làm versioning bảng vật lý, so sánh tự động 2 thời điểm toàn lớp, cập nhật ngược
> vào lớp dữ liệu — để mở rộng sau. Bước xác thực ở đây là **1 bước nhẹ** (tiếp nhận /
> xác thực / trả lại), không phải quy trình phê duyệt nhiều cấp.

## 1. Luồng nghiệp vụ

```
[Sở NN&MT]  đo GPS ─▶ draft ──submit──▶ submitted ──verify──▶ verified
                                            │
                                            └──reject──▶ rejected ──sửa──▶ draft
[Admin]                                  tiếp nhận & xác thực ▲
```

1. **Bật định vị** — app (Flutter `geolocator` / web Mapbox `GeolocateControl`) bám theo
   vị trí cán bộ trên bản đồ.
2. **Đi và ghi điểm** — đến từng mốc ranh giới khu vực biến đổi, bấm "Ghi điểm" →
   lưu `{lng, lat, accuracy_m, recorded_at}`. Vẫn cho ghi ở mọi accuracy nhưng
   **cảnh báo** khi vượt ngưỡng (xem §1.1), không chặn cứng.
3. **Khép vùng** — đủ ≥ 3 điểm thì khép polygon, app hiển thị diện tích tạm tính (turf).
4. **Gửi lên server** — server khép polygon chuẩn (`ST_MakeValid`), tính diện tích
   chính xác (`ST_Area(geom::geography)`), giao cắt với lớp dữ liệu để biết vùng đo
   **đè lên thửa/đối tượng nào, thuộc loại đất gì, mỗi phần bao nhiêu m²**, và thuộc
   xã/phường nào. **Loại đất hiện trạng (`old_land_use`) tự điền** từ kết quả giao
   cắt lớp thửa đất (xem §1.2).
5. **Bổ sung hiện trường** — chụp ảnh tại chỗ (upload MinIO), xác nhận/sửa
   `old_land_use` (đã auto-fill), nhập `new_land_use` quan sát được + ghi chú
   (vd. "đất nông nghiệp → công trình xây dựng").
6. **Gửi báo cáo (submit)** — gắn phiên đo vào một **khu vực theo dõi** (xem §1.3), rồi
   thông báo in-app + realtime đến `system_admin`: *"Sở NN&MT gửi kết quả đo biến động
   DD-2026-00001 chờ xác thực: [xã Y, 12.450 m², nông nghiệp → xây dựng]"*.
7. **Admin tiếp nhận & xác thực** (xem §1.4) — admin mở phiên đo, đối chiếu polygon/diện
   tích/ảnh/accuracy, rồi:
   - **Xác thực** (`verify`) → trạng thái `verified`, thông báo lại cho người đo +
     `ubnd_tinh` biết kết quả đã được xác nhận chính thức.
   - **Trả lại** (`reject`, bắt buộc lý do) → `rejected`, thông báo người đo sửa/đo lại.

Offline vùng không sóng: điểm ghi vào bộ nhớ máy, đồng bộ khi có mạng.

### 1.1 Độ chính xác GPS — cảnh báo, không chặn

Kon Tum phần lớn là rừng núi; dưới tán cây GPS điện thoại thường không đạt < 10 m,
nếu chặn cứng cán bộ sẽ không ghi được điểm nào giữa hiện trường. Do đó:

- **Cho phép ghi ở mọi accuracy**; app hiển thị accuracy từng điểm (xanh/vàng/đỏ theo
  ngưỡng) để cán bộ tự đánh giá, có thể đứng chờ tín hiệu tốt hơn rồi ghi lại.
- Ngưỡng cảnh báo **cấu hình được** (không hard-code) — mặc định 10 m; đặt trong config
  app + trả kèm khi server phản hồi để cả 2 phía dùng chung một giá trị.
- Server tính `avg_accuracy_m` và lưu; chi tiết/danh sách/export đều hiển thị để người
  xem (admin/UBND) biết độ tin cậy của phiên đo.

### 1.2 Loại đất hiện trạng tự điền từ lớp thửa

`old_land_use` **không để cán bộ nhập tay** (dễ chủ quan) mà **suy ra từ giao cắt** với
lớp dữ liệu thửa/hiện trạng đã có trong `gis.layer_registry`:

- Khi tạo phiên đo, server lấy thửa có diện tích giao cắt **lớn nhất** với vùng đo, đọc
  thuộc tính loại đất của thửa đó → gán vào `old_land_use`. Toàn bộ danh sách thửa bị
  đè vẫn lưu trong `affected_features` (kèm loại đất + m² từng phần).
- Cán bộ **xác nhận hoặc chỉnh** giá trị auto-fill (trường hợp dữ liệu lớp cũ/sai), rồi
  nhập `new_land_use` là hiện trạng quan sát được. Nhờ vậy "biến đổi" được **neo vào dữ
  liệu gốc** thay vì hoàn toàn chủ quan.
- Nếu vùng đo không giao với lớp thửa nào (chưa có dữ liệu nền) → `old_land_use` để trống,
  cán bộ nhập tay như thường; không chặn luồng.

> Cần chỉ định lớp thửa dùng làm nền đối chiếu — qua tham số `layer_code` khi tạo phiên
> đo, hoặc cấu hình một lớp mặc định trong config module.

### 1.3 Khu vực theo dõi — đo nhiều lần theo thời gian

Để "theo dõi biến đổi của **một** khu vực" chứ không chỉ những lần đo rời rạc, mỗi phiên
đo được gắn vào một **khu vực theo dõi** (`gis.monitored_areas`):

- **Khu vực theo dõi** = một vùng địa lý được đặt tên/mã (`KV-2026-001`), có ranh giới
  tham chiếu (`ref_geom`) và thuộc một xã/phường. Nó gom **nhiều phiên đo qua các mốc
  thời gian** của cùng chỗ đó.
- Khi tạo/submit phiên đo, cán bộ **chọn khu vực theo dõi có sẵn** hoặc **tạo mới**.
  Server hỗ trợ bằng cách **gợi ý theo không gian** ở 2 mốc (xem §1.3.1) — nhưng luôn chỉ
  là gợi ý, cán bộ bấm xác nhận mới gắn (vì 2 khu vực sát nhau có thể trùng gợi ý).
- Nhờ vậy, mở một khu vực theo dõi sẽ thấy **dòng thời gian các lần đo**: diện tích qua
  từng lần, loại đất qua từng lần, ảnh từng lần → nhìn ra diễn tiến (vd. rừng thu hẹp
  dần qua 3 lần đo trong 1 năm).
- So sánh ở đây là **giữa các lần đo trong cùng một khu vực** (nhẹ, phạm vi hẹp), khác
  với việc so sánh tự động toàn lớp giữa 2 thời điểm (đã cắt).

#### 1.3.1 Nhận biết "khu vực này đã từng đo" — 2 mốc phát hiện

**Mốc 1 — ngay khi cán bộ tới nơi (theo điểm GPS, trước khi vẽ):** app hỏi server chỗ
đang đứng có nằm gần khu vực nào đã theo dõi không — truy vấn điểm rẻ:

```sql
SELECT id, code, name
FROM gis.monitored_areas
WHERE ST_DWithin(
    ref_geom::geography,
    ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography,
    :radius_m       -- bán kính gợi ý, cấu hình được (mặc định 50 m)
);
```

Trúng → app báo sớm: *"⚠ Khu vực này đã có N lần đo (KV-2026-001), gần nhất MM/YYYY. Đo
tiếp vào khu vực này?"* → tránh tạo trùng ngay từ đầu.

**Mốc 2 — sau khi khép polygon (theo hình học, chính xác hơn):** so vùng vừa đo với
**hình lần đo gần nhất** của từng khu vực (không phải `ref_geom` lần đầu — vì khu vực
dịch/co theo thời gian, lần gần nhất phản ánh hiện trạng đúng hơn):

```sql
WITH latest AS (   -- hình lần đo gần nhất của mỗi khu vực
    SELECT DISTINCT ON (area_id) area_id, geom
    FROM gis.field_measurements
    WHERE area_id IS NOT NULL AND status = 'verified'
    ORDER BY area_id, finished_at DESC
)
SELECT ma.id, ma.code,
       ST_Area(ST_Intersection(l.geom, :new_geom)::geography) AS overlap_m2,
       ST_Area(:new_geom::geography) AS new_m2,
       ST_Area(l.geom::geography)    AS last_m2
FROM latest l
JOIN gis.monitored_areas ma ON ma.id = l.area_id
WHERE ST_Intersects(l.geom, :new_geom)
ORDER BY overlap_m2 DESC;
```

**Tỉ lệ trùng tính theo hình NHỎ hơn**, không theo hình cố định:

```
tỉ lệ = overlap_m2 / LEAST(new_m2, last_m2)   →  gợi ý nếu ≥ ngưỡng (mặc định 30%)
```

> Vì sao phải LEAST: nếu rừng 10 ha bị phá còn 2 ha, phần trùng 2 ha chỉ = 20% hình cũ
> (10 ha) nên sẽ **bỏ sót** nếu chia cho hình cũ; chia cho hình nhỏ hơn (2 ha) = 100% →
> nhận ra đúng đây là cùng khu vực đang co lại.

Ngoài 2 mốc tự động, luôn có đường **thủ công**: tìm khu vực theo tên/mã, hoặc chọn trực
tiếp trên bản đồ (endpoint `GET /monitored-areas` + `/suggest`).

### 1.4 Admin tiếp nhận & xác thực

Bước xác thực là **1 cấp nhẹ**, không phải phê duyệt nhiều tầng:

- Chỉ role có quyền `verify` (mặc định `system_admin`) mới xác thực được.
- Admin xem: polygon trên bản đồ, diện tích, `avg_accuracy_m`, ảnh hiện trường, loại đất
  trước/sau, khu vực theo dõi liên quan (kèm các lần đo trước để đối chiếu).
- **Xác thực** → `verified` + ghi `verified_by`, `verified_at`. Đây là mốc kết quả được
  công nhận chính thức để đưa vào thống kê/báo cáo.
- **Trả lại** → `rejected` + bắt buộc `review_note`; người đo sửa ghi chú/đo lại rồi
  submit lại.
- Chỉ phiên đo `verified` mới tính vào thống kê và xuất báo cáo chính thức (draft/rejected
  loại khỏi số liệu).

## 2. CSDL — migration `028_field_measurements.sql` (3 bảng)

```sql
-- Khu vực theo dõi: gom nhiều lần đo cùng một chỗ theo thời gian (§1.3)
CREATE TABLE gis.monitored_areas (
    id            BIGSERIAL PRIMARY KEY,
    code          VARCHAR(30) UNIQUE,            -- KV-2026-001, sinh tự động
    name          VARCHAR(200),                  -- tên gợi nhớ (tùy chọn)
    ref_geom      GEOMETRY(POLYGON, 4326),       -- ranh giới tham chiếu (thường = lần đo đầu)
    commune_code  VARCHAR(20),
    note          TEXT,
    created_by    BIGINT REFERENCES auth.users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_monitored_areas_geom ON gis.monitored_areas USING GIST (ref_geom);
CREATE INDEX idx_monitored_areas_commune ON gis.monitored_areas (commune_code);

CREATE TABLE gis.field_measurements (
    id                BIGSERIAL PRIMARY KEY,
    code              VARCHAR(30) UNIQUE,        -- DD-2026-00001, sinh tự động
    area_id           BIGINT REFERENCES gis.monitored_areas(id),  -- khu vực theo dõi (§1.3)
    layer_id          INT REFERENCES gis.layer_registry(id),  -- lớp đối chiếu (tùy chọn)
    points            JSONB NOT NULL,            -- [{lng,lat,accuracy_m,recorded_at},...]
    geom              GEOMETRY(POLYGON, 4326) NOT NULL,  -- polygon khép từ các điểm
    area_m2           NUMERIC(16,2) NOT NULL,    -- ST_Area(geom::geography)
    avg_accuracy_m    NUMERIC(6,2),
    commune_code      VARCHAR(20),               -- xã/phường (spatial join lúc tạo)
    affected_features JSONB DEFAULT '[]',        -- kết quả giao cắt: [{feature_id,
                                                 --   land_use, overlap_m2}, ...]
    old_land_use      VARCHAR(100),              -- auto-fill từ thửa giao cắt lớn nhất
                                                 --   (§1.2); cán bộ xác nhận/sửa được
    new_land_use      VARCHAR(100),              -- hiện trạng quan sát được (cán bộ nhập)
    note              TEXT,                      -- mô tả biến đổi
    status            VARCHAR(20) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','submitted','verified','rejected')),
    review_note       TEXT,                      -- lý do trả lại (khi rejected)
    device_info       JSONB,
    measured_by       BIGINT REFERENCES auth.users(id),
    verified_by       BIGINT REFERENCES auth.users(id),  -- admin xác thực (§1.4)
    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ,
    submitted_at      TIMESTAMPTZ,
    verified_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_field_measurements_geom ON gis.field_measurements USING GIST (geom);
CREATE INDEX idx_field_measurements_status ON gis.field_measurements (status, created_at DESC);
CREATE INDEX idx_field_measurements_area ON gis.field_measurements (area_id, finished_at DESC);

CREATE TABLE gis.field_measurement_photos (
    id             BIGSERIAL PRIMARY KEY,
    measurement_id BIGINT NOT NULL REFERENCES gis.field_measurements(id) ON DELETE CASCADE,
    minio_key      TEXT NOT NULL,
    original_name  VARCHAR(255),
    mime_type      VARCHAR(100),
    size_bytes     BIGINT,
    taken_at       TIMESTAMPTZ,                  -- thời điểm chụp (EXIF nếu có)
    uploaded_by    BIGINT REFERENCES auth.users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Quyền (pattern migration 010):
`field_measurements: { create, read, update, submit, verify, delete, export }`

| Role | Quyền |
|---|---|
| `so_nnmt` | create, read, update, submit, delete (draft của mình), export |
| `system_admin` | toàn bộ (kể cả **verify**) |
| `ubnd_tinh` | read, export (theo dõi, nhận thông báo kết quả xác thực) |

## 3. API (mount `/field-measurements` trong `routes/index.js`)

```
# Phiên đo
POST   /field-measurements                 tạo phiên đo: gửi mảng điểm GPS (+ layer_code
                                           lớp thửa nền, + area_id khu vực theo dõi nếu
                                           gắn sẵn) → server khép polygon, tính diện tích,
                                           giao cắt lớp dữ liệu, gán xã/phường,
                                           auto-fill old_land_use (§1.2)
GET    /field-measurements                 danh sách + filter (status, commune, area_id,
                                           from/to)
GET    /field-measurements/:id             chi tiết: polygon GeoJSON, diện tích, thửa bị
                                           ảnh hưởng, ảnh, ghi chú, khu vực theo dõi
PATCH  /field-measurements/:id             sửa ghi chú/loại đất/area_id khi draft|rejected
POST   /field-measurements/:id/photos      upload ảnh hiện trường (multipart → MinIO,
                                           presigned URL để xem)
DELETE /field-measurements/:id             xoá khi còn draft
POST   /field-measurements/:id/submit      gửi báo cáo → broadcastToRole('system_admin')
POST   /field-measurements/:id/verify       [admin] xác thực → verified, notify người đo
                                           + ubnd_tinh
POST   /field-measurements/:id/reject       [admin] trả lại (bắt buộc review_note) →
                                           rejected, notify người đo
GET    /field-measurements/export?format=xlsx|geojson   xuất kết quả (chỉ verified; xlsx
                                           dùng exceljs, geojson kèm geometry cho bản đồ)

# Khu vực theo dõi (§1.3)
POST   /monitored-areas                    tạo khu vực theo dõi
GET    /monitored-areas                    danh sách + filter (commune)
GET    /monitored-areas/suggest/by-point?lng=&lat=&radius_m=  [mốc 1] gợi ý khu vực gần
                                           điểm GPS (ST_DWithin)
GET    /monitored-areas/suggest/by-geom?geom=  [mốc 2] gợi ý khu vực trùng polygon vừa đo
                                           (tỉ lệ trùng theo hình nhỏ hơn, §1.3.1)
GET    /monitored-areas/:id                chi tiết khu vực
GET    /monitored-areas/:id/timeline       dòng thời gian các lần đo (diện tích, loại đất,
                                           ảnh qua từng mốc) → xem diễn tiến biến đổi
```

## 4. Thông báo

Dùng notification service sẵn có, channel `field_measurement`:

| Sự kiện | Hàm | Người nhận | Nội dung |
|---|---|---|---|
| **Submit** (Sở gửi) | `broadcastToRole('system_admin')` | Admin | "Sở NN&MT gửi kết quả đo biến động DD-2026-00001 **chờ xác thực**: xã Y, 12.450 m², nông nghiệp → xây dựng" |
| **Verify** (Admin xác thực) | `sendToUser(measured_by)` + `broadcastToRole('ubnd_tinh')` | Người đo + UBND | "Kết quả đo DD-... **đã được xác thực**: xã Y, 12.450 m², nông nghiệp → xây dựng" |
| **Reject** (Admin trả lại) | `sendToUser(measured_by)` | Người đo | "Kết quả đo DD-... bị trả lại: {review_note}" |

`data` payload: `{ measurement_id, code, area_id, commune_code, area_m2, centroid }` để
frontend mở thẳng vị trí/khu vực theo dõi trên bản đồ.

> UBND tỉnh chỉ nhận thông báo **sau khi Admin đã xác thực** (kết quả chính thức), tránh
> làm phiền bằng dữ liệu chưa kiểm chứng. Nếu nghiệp vụ muốn UBND thấy cả lúc submit,
> thêm `broadcastToRole('ubnd_tinh')` vào sự kiện Submit.

## 5. Files mới

```
src/database/migrations/028_field_measurements.sql
src/routes/field-measurement.routes.js
src/controllers/field-measurement.controller.js
src/validators/field-measurement.validator.js
src/services/field-measurement.service.js
src/repositories/field-measurement.repository.js
+ i18n keys, mount router trong src/routes/index.js
```

> Lưu ý: migration 027 đã gỡ bảng `field.field_updates` cũ (mobile) — module này là
> nghiệp vụ khác (đo đạc của Sở), dùng schema `gis`, không đụng phần đã gỡ.

## 6. Ước lượng & mở rộng sau

**Ước lượng: ~6–7 ngày** — migration (3 bảng + quyền), CRUD phiên đo, phân tích giao cắt +
auto-fill loại đất, ảnh MinIO, khu vực theo dõi + timeline + gợi ý không gian, bước
xác thực (verify/reject), notification, export.

Đã chủ đích cắt bỏ, có thể thêm sau nếu nghiệp vụ cần (thiết kế versioning đầy đủ xem
git history của file này):
- Versioning phiên bản đối tượng (`feature_versions`) + khôi phục dữ liệu lớp.
- Phê duyệt nhiều cấp (hiện chỉ 1 bước xác thực draft→submitted→verified/rejected).
- So sánh **tự động toàn lớp** giữa 2 thời điểm, ma trận chuyển đổi loại đất (hiện chỉ so
  sánh giữa các lần đo **trong một khu vực theo dõi**).
- Cảnh báo tự động biến động bất thường.
- Cập nhật ngược vào bảng vật lý lớp dữ liệu (hiện phiên đo chỉ là hồ sơ ghi nhận,
  không sửa dữ liệu lớp).

**Lưu ý pháp lý:** GPS điện thoại sai số ±3–10 m — kết quả đo mang tính ghi nhận/báo cáo
hiện trạng, không thay thế đo đạc RTK cho hồ sơ pháp lý; luôn hiển thị `avg_accuracy_m`.
