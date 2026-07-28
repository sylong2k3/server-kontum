# Tích hợp timeline layer raster rời với Mapbox

Backend dùng trực tiếp các WMS layer đã publish trong `gis.layer_registry`. Không ImageMosaic, không `TIME`, không backfill, không cần `GEOSERVER_DATA_DIR`.

## API

```http
GET /api/v1/map/layer-groups
GET /api/v1/map/layer-groups/:group/timeline
```

Nhóm hỗ trợ: `lop_phu`, `nhiet_do_be_mat`, `bien_dong_lop_phu`, `dien_bien_nhiet_do`.

Ví dụ:

```http
GET /api/v1/map/layer-groups/lop_phu/timeline
```

```json
{
  "status": 200,
  "data": {
    "group": {
      "code": "lop_phu",
      "name_vi": "Lớp phủ",
      "name_en": "Land cover"
    },
    "mode": "discrete",
    "snap": "nearest",
    "default_index": 2,
    "min_year": 1991,
    "max_year": 2023,
    "steps": [
      {
        "id": 1,
        "layer_code": "lop_phu_1991",
        "geoserver_layer": "kontum:lop_phu_1991",
        "year_from": 1991,
        "year_to": 1991,
        "label": "1991",
        "tile_url": "https://.../wms?...&layers=kontum%3Alop_phu_1991&bbox={bbox-epsg-3857}"
      }
    ]
  }
}
```

## Slider

Dùng index rời: `min=0`, `max=steps.length - 1`, `step=1`. Không nội suy raster.

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

## Thay raster nhưng giữ camera

```js
function replaceRaster(tileUrl) {
  const source = map.getSource(SOURCE_ID);
  if (source?.setTiles) {
    source.setTiles([tileUrl]);
    return;
  }

  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  map.addSource(SOURCE_ID, { type: 'raster', tiles: [tileUrl], tileSize: 256 });
  map.addLayer({
    id: LAYER_ID,
    type: 'raster',
    source: SOURCE_ID,
    paint: { 'raster-opacity': 0.72, 'raster-fade-duration': 180 },
  });
}
```

Không gọi `map.flyTo`, `map.easeTo`; camera giữ nguyên.

## Play/Pause

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

Dừng timer khi đổi nhóm hoặc unmount.

## Thêm mốc mới

Publish GeoTIFF theo luồng layer hiện có, đặt đúng:

- `layer_group`: một trong bốn nhóm trên.
- `data_year`: năm dữ liệu.
- `geoserver_layer`: layer WMS đã publish.
- Code khoảng năm nên chứa cả hai năm, ví dụ `biendonglopphu_2023_2025`.

Timeline tự nhận layer mới; không chạy script backfill.

## Checklist FE

- Hiển thị `step.label`.
- Thay `step.tile_url` khi kéo.
- Không gọi API mỗi lần kéo.
- Không tích lũy source/layer cũ.
- `steps: []`: disable slider, giữ basemap.
- Play/Pause dọn interval khi unmount.
