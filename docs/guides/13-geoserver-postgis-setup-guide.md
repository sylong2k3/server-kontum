# 13 — Hướng dẫn thực hành: GeoServer + PostGIS (vector) & GeoTIFF (raster) cho Mapbox

> Hướng dẫn từng bước cấu hình GeoServer phục vụ **2 loại dữ liệu** của dự án:
> - **Vector** từ **PostGIS** (ranh giới rừng, tiểu khu, điểm cháy…).
> - **Raster GeoTIFF** từ pipeline GEE (NDVI/NDMI/NBR, LST, bản đồ nguy cơ cháy).
>
> Tất cả phục vụ ra **Mapbox GL JS** qua Node proxy (`/api/v1/map/...`).

## 0. Nguyên tắc lưu trữ (rất quan trọng)

| Loại dữ liệu | Lưu ở đâu | GeoServer phục vụ bằng |
|--------------|-----------|------------------------|
| Vector (polygon/line/point) | **PostGIS** (schema `gis`/`fire`) | PostGIS **DataStore** → WMS/WFS/MVT |
| Raster **GeoTIFF** (NDVI, LST, FireRisk raster) | **Filesystem** (thư mục data, vd `/data/geotiff/...`) | **CoverageStore** (GeoTIFF / ImageMosaic) → WMS |

> ❗ Không nạp GeoTIFF vào PostGIS. PostGIS Raster nặng và khó vận hành; chuẩn dự án là **GeoTIFF trên đĩa + GeoServer coverage store**. PostGIS chỉ giữ vector + metadata (`gis.satellite_image`, `fire.forest_fire_warning`).

## 1. Chuẩn bị

### 1.1 Extension GeoServer cần có
| Extension | Dùng cho |
|-----------|----------|
| **gs-vectortiles** | Xuất MVT cho Mapbox vector source |
| ImageMosaic (core) | Chuỗi GeoTIFF theo thời gian (fire-risk hằng ngày) |
| GeoTIFF (core) | GeoTIFF đơn |
| (tùy chọn) CSS/SLD styling | Tô màu raster/vector |

### 1.2 Biến môi trường (đã có trong `.env.example`)
```dotenv
GEOSERVER_URL=http://localhost:8080/geoserver
GEOSERVER_USER=...
GEOSERVER_PASSWORD=...
GEOSERVER_WORKSPACE=kontum
GEOSERVER_DATASTORE=kontum_postgis
```

### 1.3 Quy ước thư mục GeoTIFF (đề xuất)
```
/data/geotiff/
├── ndvi/        2026-05-24.tif, 2026-05-29.tif ...
├── lst/
└── fire-risk/   2026-05-24.tif, 2026-05-25.tif ...   ← ImageMosaic theo ngày
```

---

## 2. Tạo Workspace (1 lần)

**UI:** Data → Workspaces → Add new → Name `kontum`, set làm default.

**REST (dùng cho tự động hóa):**
```bash
curl -u $USER:$PASS -XPOST -H "Content-Type: text/xml" \
  "$GEOSERVER_URL/rest/workspaces" \
  -d "<workspace><name>kontum</name></workspace>"
```

---

## 3. VECTOR — PostGIS DataStore + publish layer

### 3.1 Tạo PostGIS DataStore
**UI:** Stores → Add new store → **PostGIS** → workspace `kontum`, name `kontum_postgis`:
- host = DB host, port `5432`, database = `DB_NAME`
- **schema** = `gis` (hoặc `fire`)
- user/password = tài khoản **read-only** riêng cho GeoServer

**REST:**
```bash
curl -u $USER:$PASS -XPOST -H "Content-Type: text/xml" \
  "$GEOSERVER_URL/rest/workspaces/kontum/datastores" -d '
<dataStore>
  <name>kontum_postgis</name>
  <connectionParameters>
    <host>DB_HOST</host><port>5432</port>
    <database>DB_NAME</database><schema>gis</schema>
    <user>geoserver_ro</user><passwd>***</passwd>
    <dbtype>postgis</dbtype>
  </connectionParameters>
</dataStore>'
```

### 3.2 Publish 1 bảng PostGIS thành layer
```bash
curl -u $USER:$PASS -XPOST -H "Content-Type: text/xml" \
  "$GEOSERVER_URL/rest/workspaces/kontum/datastores/kontum_postgis/featuretypes" -d '
<featureType>
  <name>ranh_gioi_rung</name>
  <srs>EPSG:4326</srs>
  <enabled>true</enabled>
</featureType>'
```
→ Layer khả dụng: `kontum:ranh_gioi_rung` (WMS/WFS, và MVT nếu bật vectortiles).

### 3.3 Bật MVT cho layer (Mapbox vector source)
**UI:** Layers → chọn layer → tab **Tile Caching** → thêm format `application/vnd.mapbox-vector-tile`.
Mapbox tiêu thụ: `/api/v1/map/wmts/kontum:ranh_gioi_rung/{z}/{x}/{y}.pbf` (xem doc 12 §7.2).

---

## 4. RASTER GeoTIFF — phần trọng tâm

### 4.1 Trường hợp A: GeoTIFF đơn (vd 1 ảnh NDVI cố định)

**UI:** Stores → Add new store → **GeoTIFF** → workspace `kontum`:
- name `ndvi_20260524`
- URL file: `file:///data/geotiff/ndvi/2026-05-24.tif`
→ Publish → layer `kontum:ndvi_20260524`.

**REST:**
```bash
curl -u $USER:$PASS -XPUT -H "Content-Type: text/plain" \
  "$GEOSERVER_URL/rest/workspaces/kontum/coveragestores/ndvi_20260524/external.geotiff?configure=first&coverageName=ndvi_20260524" \
  -d "file:///data/geotiff/ndvi/2026-05-24.tif"
```

### 4.2 Trường hợp B: Chuỗi GeoTIFF theo thời gian — ImageMosaic (DÙNG CHO FIRE-RISK HẰNG NGÀY)

Mỗi ngày cron sinh 1 file `fire-risk/YYYY-MM-DD.tif`. Dùng **ImageMosaic** + **time dimension** để có "bản đồ mới nhất" và xem theo ngày.

**Bước 1 — Chuẩn bị thư mục mosaic** `/data/geotiff/fire-risk/` chứa các `.tif` đặt tên theo ngày, kèm 3 file cấu hình:

`indexer.properties`
```properties
TimeAttribute=ingestion
Schema=*the_geom:Polygon,location:String,ingestion:java.util.Date
PropertyCollectors=TimestampFileNameExtractorSPI[timeregex](ingestion)
```

`timeregex.properties`
```properties
regex=[0-9]{4}-[0-9]{2}-[0-9]{2}
```

(GeoServer tự sinh `<mosaic>.properties` + index sau lần publish đầu.)

**Bước 2 — Tạo CoverageStore ImageMosaic (REST):**
```bash
curl -u $USER:$PASS -XPUT -H "Content-Type: text/plain" \
  "$GEOSERVER_URL/rest/workspaces/kontum/coveragestores/fire_risk/external.imagemosaic?configure=first&coverageName=fire_risk" \
  -d "file:///data/geotiff/fire-risk/"
```

**Bước 3 — Bật time dimension cho coverage:**
**UI:** Layers → `kontum:fire_risk` → tab **Dimensions** → bật **Time**, Presentation = *List*, Default value = **Nearest to now** (hoặc *Maximum*) → để Mapbox lấy ảnh mới nhất khi không truyền TIME.

**Bước 4 — Thêm GeoTIFF ngày mới vào mosaic (REST, gọi từ cron):**
```bash
# Copy file vào thư mục mosaic rồi "harvest"
curl -u $USER:$PASS -XPOST -H "Content-Type: text/plain" \
  "$GEOSERVER_URL/rest/workspaces/kontum/coveragestores/fire_risk/external.imagemosaic" \
  -d "file:///data/geotiff/fire-risk/2026-05-25.tif"
```

### 4.3 Style raster bằng SLD (ColorMap)

Ví dụ SLD tô màu **bản đồ nguy cơ cháy 5 cấp** (raster 1 band giá trị `risk_level` 1–5):
```xml
<RasterSymbolizer>
  <ColorMap type="values">
    <ColorMapEntry color="#00cc44" quantity="1" label="Thấp"/>
    <ColorMapEntry color="#ffff00" quantity="2" label="Trung bình"/>
    <ColorMapEntry color="#ff9900" quantity="3" label="Cao"/>
    <ColorMapEntry color="#ff0000" quantity="4" label="Rất cao"/>
    <ColorMapEntry color="#800000" quantity="5" label="Nguy hiểm"/>
  </ColorMap>
</RasterSymbolizer>
```
Ví dụ SLD cho **NDVI** (giá trị liên tục -1..1, kiểu `ramp`):
```xml
<RasterSymbolizer>
  <ColorMap type="ramp">
    <ColorMapEntry color="#a50026" quantity="0.0" label="Đất trống"/>
    <ColorMapEntry color="#ffffbf" quantity="0.4" label="Thưa"/>
    <ColorMapEntry color="#006837" quantity="0.8" label="Rừng dày"/>
  </ColorMap>
</RasterSymbolizer>
```
Upload SLD + gán default style (REST):
```bash
curl -u $USER:$PASS -XPOST -H "Content-Type: application/vnd.ogc.sld+xml" \
  --data-binary @fire_risk.sld "$GEOSERVER_URL/rest/workspaces/kontum/styles?name=fire_risk_style"
curl -u $USER:$PASS -XPUT -H "Content-Type: application/json" \
  "$GEOSERVER_URL/rest/layers/kontum:fire_risk" \
  -d '{"layer":{"defaultStyle":{"name":"kontum:fire_risk_style"}}}'
```

### 4.4 Hiển thị raster GeoTIFF trên Mapbox
```js
// Bản đồ nguy cơ cháy mới nhất (GeoServer tự chọn time gần nhất)
map.addSource('fire-risk-wms', {
  type: 'raster',
  tiles: [
    '/api/v1/map/wms?service=WMS&version=1.3.0&request=GetMap' +
    '&layers=kontum:fire_risk&styles=kontum:fire_risk_style' +
    '&bbox={bbox-epsg-3857}&width=256&height=256' +
    '&crs=EPSG:3857&format=image/png&transparent=true'
    // Xem ngày cụ thể: thêm &TIME=2026-05-24
  ],
  tileSize: 256
});
map.addLayer({ id: 'fire-risk-raster', type: 'raster', source: 'fire-risk-wms', paint: { 'raster-opacity': 0.6 } });
```
Popup giá trị tại điểm (WMS GetFeatureInfo) qua proxy: `/api/v1/map/wms?...&request=GetFeatureInfo&query_layers=kontum:fire_risk&i=..&j=..&info_format=application/json`.

---

## 5. Tự động publish GeoTIFF từ cron Node (REST)

Gắn vào `fire-risk.job.js` sau khi GEE export GeoTIFF về `/data/geotiff/fire-risk/`:
```js
// src/utils/geoserver.client.js — harvest GeoTIFF mới vào ImageMosaic
async function harvestGeoTiff(coverageStore, tifPath) {
  const url = `${process.env.GEOSERVER_URL}/rest/workspaces/${process.env.GEOSERVER_WORKSPACE}` +
              `/coveragestores/${coverageStore}/external.imagemosaic`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'Authorization': 'Basic ' + Buffer.from(`${process.env.GEOSERVER_USER}:${process.env.GEOSERVER_PASSWORD}`).toString('base64'),
    },
    body: `file://${tifPath}`,
  });
  if (!res.ok) throw new Error(`GeoServer harvest failed: ${res.status}`);
}
// Sau harvest: truncate cache GWC layer để client thấy dữ liệu mới (xem §6)
```
Pipeline đầy đủ:
```
GEE export fire-risk/2026-05-25.tif → /data/geotiff/fire-risk/
   → harvestGeoTiff('fire_risk', '/data/geotiff/fire-risk/2026-05-25.tif')
   → GWC truncate layer 'kontum:fire_risk'
   → Mapbox WMS tự lấy ảnh ngày mới nhất
```

---

## 6. GeoWebCache cho raster/vector
- Bật cache cho layer raster tĩnh và vector nền.
- **Sau mỗi lần harvest GeoTIFF mới**, gọi truncate để xóa tile cũ:
```bash
curl -u $USER:$PASS -XPOST -H "Content-Type: application/json" \
  "$GEOSERVER_URL/gwc/rest/seed/kontum:fire_risk.json" -d '
{"seedRequest":{"name":"kontum:fire_risk","type":"truncate","zoomStart":0,"zoomStop":16,"format":"image/png"}}'
```

---

## 7. Checklist triển khai
- [ ] Workspace `kontum` + PostGIS store `kontum_postgis` (user read-only).
- [ ] Publish vector layer + bật MVT (gs-vectortiles).
- [ ] Thư mục `/data/geotiff/...` mount vào container GeoServer.
- [ ] ImageMosaic `fire_risk` + bật Time dimension (default = nearest now).
- [ ] SLD raster (fire-risk 5 cấp, NDVI ramp) + gán default style.
- [ ] Cron Node harvest GeoTIFF mới + truncate GWC.
- [ ] Proxy `/api/v1/map/wms|wfs|wmts` allowlist + RBAC (doc 12 §5).
- [ ] GeoServer chỉ bind nội bộ.

## 8. Troubleshooting nhanh
| Triệu chứng | Nguyên nhân thường gặp |
|-------------|------------------------|
| Mapbox không thấy raster mới | Chưa truncate GWC / Time default chưa phải "nearest now" |
| Tile lệch vị trí | Quên `crs=EPSG:3857` / `{bbox-epsg-3857}` cho WMS |
| MVT không hiển thị | Chưa cài gs-vectortiles / sai `source-layer` |
| GeoTIFF không nạp | Sai đường dẫn `file://`, GeoServer không có quyền đọc thư mục mount |
| ImageMosaic không nhận ngày | `timeregex` không khớp tên file (phải có `YYYY-MM-DD`) |
| Màu raster sai | SLD ColorMap `type` sai (values vs ramp) hoặc band/giá trị lệch |
