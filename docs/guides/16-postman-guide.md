# 16 — Hướng dẫn sử dụng bộ Postman Collection

> Hướng dẫn thực hành cho **BA/QA/Dev** dùng bộ Postman trong thư mục [`postman/`](../../postman/) để gọi thử, kiểm thử thủ công và kiểm thử hồi quy API `server-kontum`. Không cần đọc code vẫn dùng được — mọi request đã kèm mô tả trường dữ liệu, script tự động lưu ID, và test tự động PASS/FAIL.
>
> Có 2 file, mục đích khác nhau — đọc kỹ mục 1 trước khi chọn file để dùng.

## 1. Có gì trong `postman/`

| File | Dùng để làm gì | Khi nào mở |
|---|---|---|
| [`Kontum-API.postman_collection.json`](../../postman/Kontum-API.postman_collection.json) | **Luồng nghiệp vụ hợp lệ** — mỗi endpoint 1 request mẫu với dữ liệu đúng, chạy xong thành công (200/201). Dùng để demo, để dev gọi thử tay, để QA đi qua toàn bộ luồng nghiệp vụ. | Muốn *thử API hoạt động đúng như thế nào*. |
| [`Kontum-API-Validators.postman_collection.json`](../../postman/Kontum-API-Validators.postman_collection.json) | **Bộ test hồi quy** — chứa lại toàn bộ request hợp lệ ở trên (folder **"Hợp lệ"**) **cộng thêm** hàng trăm request cố ý sai (folder **"Validator 400"**: thiếu field, sai kiểu, sai enum, vượt giới hạn...) để xác nhận Joi validate đúng — không "lọt lưới" dữ liệu bẩn. | Muốn *xác nhận validate còn hoạt động đúng* sau khi sửa code (regression test). |

Cả hai đều là **Postman Collection v2.1** — import được thẳng vào Postman Desktop/Web, hoặc chạy bằng CLI (Newman) không cần mở app. Không có file `.postman_environment.json` riêng vì mọi biến (kể cả `baseUrl`) đã khai báo sẵn ở cấp **Collection Variables** — import xong là chạy được ngay, không cần dựng thêm environment.

## 2. Import vào Postman

1. Mở Postman → **Import** (góc trên trái) → chọn cả 2 file JSON trong `postman/` (kéo-thả hoặc "Choose Files").
2. Sau khi import, mỗi file xuất hiện thành 1 **Collection** riêng trong sidebar: *"API Quản lý GIS Kon Tum — Chuẩn"* và bản có hậu tố *Validators*.
3. Không cần chọn Environment gì thêm — mặc định collection đã trỏ tới server test:

   ```
   baseUrl = https://apikontum.tourismpj.pro.vn/api/v1
   ```

   Muốn đổi sang máy local khi dev, sửa trực tiếp biến `baseUrl` ở **Collection → Variables** (ví dụ `http://localhost:3000/api/v1`), không cần sửa từng request.

## 3. Trước khi gọi bất kỳ request nào: đăng nhập lấy token

Gần như mọi endpoint đều yêu cầu Bearer token (trừ vài endpoint public như `/auth/login`, `/auth/register`). Collection đã cấu hình **Authorization kiểu Bearer ở cấp Collection**, trỏ tới biến `{{accessToken}}` — bạn **không phải** tự gắn header `Authorization` cho từng request.

**Cách lấy token — chỉ 1 bước:**

1. Mở folder **Auth** → chạy **`POST /auth/login — Đăng nhập - Admin (system_admin)`**.
2. Request này dùng sẵn `{{email}}` = `admin@example.com`, `{{password}}` = `Password123` (đổi được ở Collection Variables nếu server test đổi mật khẩu).
3. Script `test` của request tự động lưu `accessToken`, `refreshToken`, `userId` vào **Collection Variables** — mọi request sau đó trong collection tự dùng token này, không cần copy/paste tay.

> Token hết hạn (401)? Chạy lại `POST /auth/login` một lần nữa, hoặc dùng `POST /auth/refresh — Làm mới token` (đã tự đọc `{{refreshToken}}`).

**Vai trò & quyền:** endpoint đo đạc thực địa (`/field-measurements`) yêu cầu quyền `field_measurements.create` — tài khoản `system_admin` có sẵn quyền này nên login Admin ở trên là đủ để test toàn bộ luồng. Nếu cần test đúng theo vai trò cán bộ Sở NN&MT (`so_nnmt`), tạo thêm 1 tài khoản role đó qua `POST /auth/register` hoặc nhờ admin cấp, rồi login bằng tài khoản đó.

## 4. Chạy 1 request vs chạy cả luồng (Collection Runner)

- **Chạy 1 request:** mở request → **Send**. Xem kết quả ở tab **Body** (dữ liệu trả về) và tab **Test Results** (bao nhiêu test pass/fail).
- **Chạy cả luồng nhiều bước** (ví dụ: tạo phiên đo → thêm ảnh → submit → verify): dùng **Collection Runner** (icon ▶ cạnh tên collection, hoặc chuột phải folder → *Run folder*). Postman sẽ chạy tuần tự từng request **theo đúng thứ tự trong sidebar** — đây là lý do các request được sắp trước/sau có chủ đích (vd. `POST /field-measurements` luôn đứng trước `PATCH/DELETE /field-measurements/:id` vì các request sau cần `{{fieldMeasurementId}}` mà request tạo mới vừa lưu).

> ⚠️ Chạy **Runner cho cả collection gốc** sẽ tạo dữ liệu thật trên server test (user, phiên đo, phản ánh...). Đây là hành vi có chủ đích (server test dùng riêng cho việc này) — nhưng nếu đang trỏ `baseUrl` vào **production**, tuyệt đối không chạy Runner toàn bộ.

## 5. Đọc kết quả một request

Mỗi request đều có sẵn **test script** tự động (tab "Tests" trong Postman, hoặc trong JSON là `event[].listen == "test"`), tối thiểu kiểm tra:

- HTTP status đúng như kỳ vọng (thường `200/201/202/204` cho luồng hợp lệ, `400` cho request cố ý sai).
- Thời gian phản hồi < 30s (cảnh báo sớm nếu server/GEE bị treo).
- Có header `Content-Type` (tránh trả về HTML lỗi thay vì JSON khi có exception).

Xem kết quả ở tab **Test Results** ngay dưới nút Send — dòng nào ✅ là pass, ❌ là fail kèm lý do. Muốn xem log chi tiết hơn (`console.log` trong script), mở **Postman Console** (View → Show Postman Console, hoặc `Alt+Ctrl+C`) **trước khi** bấm Send.

Một số request còn tự lưu ID vừa tạo vào Collection Variables để request kế tiếp dùng lại — ví dụ tạo phiên đo xong, `{{fieldMeasurementId}}` tự cập nhật thành ID mới, không cần bạn sửa tay.

## 6. Thực hành: kiểm tra chống tạo trùng phiên đo (`clientUuid`)

Đây là 2 request minh hoạ tính năng **idempotency** mới thêm cho `POST /field-measurements` (xem thiết kế ở [`17-change-tracking-design.md`](../modules/17-change-tracking-design.md)): app hiện trường mất sóng ngay sau khi server đã lưu thành công thì tự động gửi lại y nguyên request — server phải nhận ra đây là bản ghi cũ, **không tạo thêm dòng trùng**.

Vào folder **"Đo đạc thực địa"** trong collection gốc, 2 request đầu tiên:

| # | Request | Ý nghĩa |
|---|---------|---------|
| 1 | **`POST /field-measurements`** | Tạo phiên đo **mới**. Mỗi lần bấm Send, script *Pre-request* tự sinh 1 `clientUuid` (UUID v4) mới, lưu vào biến `{{fieldMeasurementClientUuid}}`, rồi gửi kèm trong body. |
| 2 | **`POST /field-measurements (Retry — clientUuid trùng)`** | Mô phỏng app **gửi lại** đúng request vừa rồi (cùng `clientUuid`, không sinh mới). |

**Cách test:**

1. Bấm **Send** ở request 1 → kỳ vọng `HTTP 201`, body có `"duplicated": false`, và một `id` mới (vd. `42`).
2. Bấm **Send** ngay ở request 2 (**không sửa gì, không chạy lại request 1**) → kỳ vọng:
   - `HTTP 200` (không phải `201` — vì không có gì được **tạo mới**, chỉ trả lại bản ghi cũ).
   - `"duplicated": true`.
   - `"id"` **giống hệt** id ở bước 1.
3. Vào **Postman Console** để xem dòng log dạng:
   ```
   [field-measurements] clientUuid=3f9e... duplicated=false id=42
   [field-measurements retry] clientUuid=3f9e... -> id=42 (khong doi so voi lan tao dau)
   ```
   Cùng 1 `clientUuid`, cùng 1 `id` ở cả 2 lần gọi → chứng minh không có phiên đo trùng nào bị tạo thêm trong DB dù request bị gửi 2 lần.

**Muốn test lại từ đầu (tạo phiên đo hoàn toàn mới)?** Chỉ cần bấm **Send** lại ở request 1 — script Pre-request luôn sinh `clientUuid` mới mỗi lần, nên không cần xoá tay biến collection. Chỉ khi nào muốn ép `clientUuid` cụ thể (ví dụ debug 1 case lỗi thật từ log server), sửa trực tiếp biến `fieldMeasurementClientUuid` ở **Collection → Variables** trước khi Send.

**Test 400 tương ứng** (giới hạn `clientUuid` tối đa 80 ký tự) nằm ở bộ Validators: `Đo đạc thực địa → Validator 400 → "[400] POST /field-measurements — clientUuid vượt quá 80 ký tự"`.

## 7. Bộ Validators — khi nào dùng

Mở `Kontum-API-Validators.postman_collection.json`, cấu trúc mỗi module chia làm 2 folder con:

- **"Hợp lệ"** — bản sao các request đúng (giống hệt collection gốc, đồng bộ tay khi thêm field mới).
- **"Validator 400"** — mỗi request cố ý sai **1 điều kiện duy nhất** (tên request luôn bắt đầu `[400] ...` mô tả đúng điều kiện sai đó), kỳ vọng server trả `400` kèm thông điệp lỗi rõ ràng.

Dùng bộ này khi:
- Vừa sửa/thêm Joi validator (`src/validators/*.js`) — chạy Runner cả folder "Validator 400" của module liên quan, đảm bảo không có request nào vô tình đổi từ ❌ 400 (đúng) sang ✅ 200 (validate bị "lỏng" đi ngoài ý muốn).
- Review PR có đụng tới input của 1 endpoint — chạy nhanh để chắc chắn các rule biên (min/max/enum/required) còn đứng.

## 8. Chạy không cần mở Postman (Newman CLI)

Dùng khi cần chạy trong CI, hoặc chạy nhanh 1 folder mà không muốn mở app:

```bash
# Cài 1 lần (hoặc dùng npx, không cần cài global)
npm install -g newman

# Chạy toàn bộ collection hợp lệ nhắm vào server test
newman run postman/Kontum-API.postman_collection.json

# Chỉ chạy 1 folder (vd. đăng nhập trước, rồi tới đo đạc thực địa)
newman run postman/Kontum-API.postman_collection.json --folder "Auth"
newman run postman/Kontum-API.postman_collection.json --folder "Đo đạc thực địa"

# Xuất báo cáo HTML để đính kèm PR/report
npx newman run postman/Kontum-API-Validators.postman_collection.json \
  --reporters cli,html --reporter-html-export newman-report.html
```

> `--folder` chỉ chạy đúng request trong folder đó — nếu folder cần token (gần như tất cả, trừ Auth), phải chạy kèm `--folder "Auth"` trước hoặc chạy nguyên collection để login tự set `{{accessToken}}` trong cùng 1 lần chạy (Newman giữ biến xuyên suốt 1 lần `run`, giống Runner trong app).

## 9. Sự cố thường gặp

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `401 Unauthorized` dù đã login | `accessToken` hết hạn (JWT có TTL) | Chạy lại `POST /auth/login` hoặc `POST /auth/refresh` |
| `403 Forbidden` | Tài khoản đang login không đủ quyền (`role` không có permission cho endpoint đó) | Kiểm tra bảng phân quyền ở [`06-api-design.md`](../architecture/06-api-design.md), login bằng tài khoản đúng vai trò |
| `400` dù dữ liệu nhìn "có vẻ đúng" | Sai định dạng field (vd. thiếu `Z` trong ISO date, `lng/lat` ngoài khung tỉnh Kon Tum 106–109°E/13–16.5°N) | Đọc kỹ phần **description** của request — mọi rule Joi đều liệt kê sẵn ở đó |
| Request phụ thuộc biến `{{...}}` không thay | Chưa chạy request "tạo" tương ứng trước đó (vd. gọi `PATCH /field-measurements/:id` trước khi tạo phiên đo) | Chạy đúng thứ tự trong sidebar, hoặc set tay biến ở Collection Variables |
| Response time cảnh báo/timeout | Endpoint gọi Google Earth Engine (vệ tinh/phân loại rừng) — có thể mất 10–20s | Bình thường với nhóm endpoint GEE; không phải lỗi nếu vẫn trả 200 trước 30s |

## 10. Thêm endpoint mới — checklist đồng bộ Postman

Khi thêm route mới trong `src/routes/`, cập nhật Postman **cùng lúc** (đừng để dồn — file sẽ lệch code rất nhanh):

1. Thêm 1 request **hợp lệ** vào `Kontum-API.postman_collection.json`, đặt trong đúng folder module, mô tả (`request.description`) liệt kê **đầy đủ rule Joi** (bắt buộc/không, kiểu, min/max/enum) — đây là nguồn tra cứu nhanh cho FE/mobile, không phải chỉ để đẹp.
2. Copy y nguyên request đó sang folder **"Hợp lệ"** tương ứng trong `Kontum-API-Validators.postman_collection.json`.
3. Với mỗi rule validate quan trọng, thêm 1 request `[400] ...` mô tả đúng 1 điều kiện sai vào folder **"Validator 400"** cùng module.
4. Nếu response trả ID mới cần dùng lại ở request khác, thêm script `test` lưu vào Collection Variable (theo mẫu `pm.collectionVariables.set("xxxId", String(data.id))`) và khai báo biến đó ở **Collection → Variables** với giá trị mặc định `"1"` hoặc rỗng.
5. Test lại bằng Newman (`newman run ... --folder "<module>"`) trước khi commit, để chắc JSON không lỗi cú pháp và thứ tự request không bị đảo.
