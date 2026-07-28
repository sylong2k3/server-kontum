# Tích hợp timeline lớp phủ với Mapbox (FE)

Backend cung cấp timeline **rời rạc**. FE kéo slider tới đâu thì snap về mốc dữ liệu gần nhất; chỉ thay raster source, không đổi camera bản đồ.

## 1. API

Base path: `/api/v1/map`. Hai API đọc dùng được không cần token nếu nhóm public. Có thể gửi `Authorization: Bearer <access_token>` cho nhóm private.

### Danh sách nhóm

```http
GET /api/v1/map/layer-groups
```

```json
{
  "message": "Lấy danh sách nhóm lớp theo thời gian thành công",
  "status": 200,
  "data": {
    "items": [
      {
        "code": "lop_phu",
        "name_vi": "Lớp phủ",
        "name_en": "Land cover",
        "step_count": 3,
        "min_year": 1991,
        "max_year": 2023,
        "geoserver_layer": "kontum:lop_phu",
        "default_style": null
      }
    ]
  },
  "metadata": { "count": 1 }
}
```

Nhóm seed sẵn:

| `code` | Nội dung |
|---|---|
| `lop_phu` | Lớp phủ từng năm |
| `nhiet_do_be_mat` | Nhiệt độ bề mặt từng năm |
| `bien_dong_lop_phu` | Biến động lớp phủ theo khoảng năm |
| `dien_bien_nhiet_do` | Diễn biến nhiệt độ theo khoảng năm |

### Timeline một nhóm

```http
GET /api/v1/map/layer-groups/lop_phu/timeline
```

```json
{
  "message": "Lấy timeline lớp phủ thành công",
  "status": 200,
  "data": {
    "group": {
      "code": "lop_phu",
      "name_vi": "Lớp phủ",
      "name_en": "Land cover",
      "geoserver_layer": "kontum:lop_phu",
      "default_style": null
    },
    "mode": "discrete",
    "snap": "nearest",
    "default_index": 2,
    "min_year": 1991,
    "max_year": 2023,
    "steps": [
      {
        "id": 1,
        "year_from": 1991,
        "year_to": 1991,
        "label": "1991",
        "time": "1991-04-02",
        "tile_url": "https://.../wms?...&time=1991-04-02&bbox={bbox-epsg-3857}"
      },
      {
        "id": 2,
        "year_from": 1991,
        "year_to": 2014,
        "label": "1991–2014",
        "time": "2014-04-02",
        "tile_url": "https://.../wms?...&time=2014-04-02&bbox={bbox-epsg-3857}"
      }
    ]
  }
}
```

> `time` là khóa kỹ thuật của GeoServer. UI luôn hiển thị `label`; không tự dựng label từ `time`.

## 2. Slider nên dùng index, không dùng mọi năm

Dữ liệu không liên tục. Slider có `min=0`, `max=steps.length - 1`, `step=1`. Cách này bảo đảm kéo luôn dừng đúng mốc có raster.

```html
<input id="map-timeline" type="range" min="0" max="0" step="1" value="0" />
<output id="map-timeline-label" for="map-timeline"></output>
```

```js
const SOURCE_ID = 'layer-series-source';
const LAYER_ID = 'layer-series-raster';
let timeline;

async function loadTimeline(groupCode) {
  const response = await fetch(`/api/v1/map/layer-groups/${groupCode}/timeline`);
  if (!response.ok) throw new Error(`Timeline HTTP ${response.status}`);

  timeline = (await response.json()).data;
  const slider = document.getElementById('map-timeline');
  slider.max = Math.max(0, timeline.steps.length - 1);
  slider.value = timeline.default_index ?? 0;
  slider.disabled = timeline.steps.length === 0;
  showStep(Number(slider.value));
}

function showStep(index) {
  const step = timeline?.steps[index];
  if (!step) return;

  document.getElementById('map-timeline-label').textContent = step.label;
  replaceRaster(step.tile_url);
}

document.getElementById('map-timeline').addEventListener('input', (event) => {
  showStep(Number(event.target.value));
});
```

## 3. Thay raster source Mapbox

Mapbox GL JS không có API đổi `tiles` tại runtime ổn định cho mọi version. Cách tương thích: xóa layer, xóa source, thêm lại. Camera không bị ảnh hưởng.

```js
function replaceRaster(tileUrl) {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);

  map.addSource(SOURCE_ID, {
    type: 'raster',
    tiles: [tileUrl],
    tileSize: 256,
  });

  map.addLayer({
    id: LAYER_ID,
    type: 'raster',
    source: SOURCE_ID,
    paint: {
      'raster-opacity': 0.72,
      'raster-fade-duration': 180,
    },
  });
}
```

Nếu app dùng MapLibre/Mapbox version có `RasterTileSource.setTiles`, ưu tiên:

```js
const source = map.getSource(SOURCE_ID);
if (source?.setTiles) source.setTiles([tileUrl]);
else replaceRaster(tileUrl);
```

## 4. Kéo theo năm liên tục (tùy chọn)

Nếu thiết kế slider bắt buộc chạy từ `min_year` đến `max_year`, snap về step gần nhất theo `year_to`:

```js
function nearestStepIndex(steps, selectedYear) {
  return steps.reduce((best, step, index) => {
    const distance = Math.abs(step.year_to - selectedYear);
    return distance < best.distance ? { index, distance } : best;
  }, { index: 0, distance: Infinity }).index;
}

const index = nearestStepIndex(timeline.steps, Number(slider.value));
showStep(index);
```

Khi khoảng cách bằng nhau, hàm giữ mốc cũ hơn. Muốn ưu tiên mốc mới hơn, dùng `distance <= best.distance`.

## 5. Play/Pause

```js
let timer;
function play() {
  clearInterval(timer);
  const slider = document.getElementById('map-timeline');
  timer = setInterval(() => {
    const next = (Number(slider.value) + 1) % timeline.steps.length;
    slider.value = next;
    showStep(next);
  }, 1200);
}
function pause() {
  clearInterval(timer);
  timer = undefined;
}
```

Dừng timer khi đổi nhóm, đóng màn hình hoặc map bị dispose.

## 6. Upload granule (màn hình quản trị)

```http
POST /api/v1/map/layer-groups/:group/granules
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

| Field | Bắt buộc | Ví dụ |
|---|---:|---|
| `file` | Có | `lop_phu_2024.tif` |
| `year_from` | Có | `2024` |
| `year_to` | Không; mặc định bằng `year_from` | `2024` |
| `label` | Không | `2024` |
| `force` | Không | `false` |

Quyền cần: `map_layers.harvest`. Giới hạn mặc định 500 MB; backend cấu hình bằng `LAYER_SERIES_MAX_MB`.

## 7. Xử lý lỗi

- `404 GROUP_NOT_FOUND`: ẩn timeline; nhóm chưa cấu hình hoặc inactive.
- `403 MAP_LAYER_READ_FORBIDDEN`: yêu cầu đăng nhập/quyền đọc.
- `409 GRANULE_EXISTS`: mốc đã có; quản trị xác nhận trước khi gửi lại `force=true`.
- `steps: []`: disable slider, không thêm raster source.
- Tile WMS lỗi: giữ basemap; hiện trạng thái “Không tải được lớp phủ”.
- Không gọi API mỗi lần kéo. Timeline đã chứa đủ `tile_url`.

## 8. Checklist FE

- Slider snap đúng từng phần tử `steps`.
- Nhãn lấy từ `step.label`.
- Kéo không gọi `map.flyTo`, `map.easeTo` hoặc đổi camera.
- Layer cũ được thay, không tích lũy nhiều source/layer.
- `raster-fade-duration` tạo chuyển cảnh ngắn.
- Play/Pause dọn interval khi unmount.
- Empty/error state không làm mất basemap.
