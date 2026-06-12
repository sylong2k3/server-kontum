# Requirements Document

## Introduction

Hệ thống WebGIS + MobileGIS phục vụ giám sát rừng, môi trường và **dự báo cháy rừng** cho tỉnh Kon Tum. Backend là Node.js + Express + PostgreSQL/PostGIS, sử dụng **GeoServer** để phục vụ lớp bản đồ theo chuẩn OGC (WMS/WMTS/WFS), tích hợp **Google Earth Engine (GEE)** và **NASA FIRMS** cho pipeline dự báo/phát hiện cháy.

Hệ thống đã có sẵn module Auth hoàn chỉnh (JWT, Google OAuth, quên/đổi mật khẩu) và RBAC với 4 vai trò: `system_admin`, `ubnd_tinh`, `so_nnmt`, `citizen`. Tài liệu này đặc tả các yêu cầu mở rộng để hoàn thiện nền tảng theo "Danh mục chức năng WebGIS-MobileGIS Kon Tum".

## Glossary

- **system_admin** — Quản trị hệ thống: toàn quyền nền tảng, người dùng, dữ liệu, API, cấu hình.
- **ubnd_tinh** — UBND tỉnh: giám sát điều hành cấp tỉnh, theo dõi báo cáo, cảnh báo, thống kê.
- **so_nnmt** — Sở NN&MT: đơn vị nghiệp vụ chính, cập nhật dữ liệu, phân tích ảnh, giám sát rừng, dự báo cháy.
- **citizen** — Người dân: tra cứu thông tin công khai, xem bản đồ, gửi phản ánh, cập nhật hiện trạng qua MobileGIS.
- **PostGIS** — Phần mở rộng không gian của PostgreSQL, nguồn dữ liệu chung.
- **GeoServer** — Server bản đồ phục vụ chuẩn OGC (WMS/WMTS/WFS) đọc trực tiếp PostGIS.
- **GEE** — Google Earth Engine, nền tảng tính toán ảnh vệ tinh.
- **FIRMS** — NASA Fire Information for Resource Management System, điểm cháy thực tế VIIRS/MODIS.
- **FireRisk** — Chỉ số nguy cơ cháy tổng hợp có trọng số, phân 5 cấp.

## Requirements

### Requirement 1: Quản trị người dùng

**User Story:** Là quản trị hệ thống, tôi muốn quản lý tài khoản và phân quyền người dùng, để kiểm soát truy cập theo vai trò.

#### Acceptance Criteria

1. WHEN system_admin tạo tài khoản mới THEN hệ thống SHALL lưu user với role được chỉ định và trả về thông tin (không gồm password hash).
2. WHEN system_admin khóa/mở khóa tài khoản THEN hệ thống SHALL cập nhật `is_active` và chặn/cho phép đăng nhập tương ứng.
3. WHEN system_admin cấp lại mật khẩu cho user THEN hệ thống SHALL đặt mật khẩu tạm và buộc đổi ở lần đăng nhập kế tiếp.
4. WHEN so_nnmt quản lý tài khoản THEN hệ thống SHALL chỉ cho phép thao tác trên tài khoản chuyên môn cấp sở (không phải toàn hệ thống).
5. WHEN người dùng bất kỳ truy cập hồ sơ cá nhân THEN hệ thống SHALL cho phép xem/sửa thông tin cá nhân của chính họ.
6. IF người dùng không đủ quyền THEN hệ thống SHALL trả về lỗi 403 với thông điệp song ngữ.

### Requirement 2: Quản trị lớp dữ liệu bản đồ & GeoServer

**User Story:** Là Sở NN&MT, tôi muốn quản lý các lớp dữ liệu bản đồ và publish chúng để hiển thị trên WebGIS.

#### Acceptance Criteria

1. WHEN người dùng có quyền import shapefile hoặc excel THEN hệ thống SHALL nạp dữ liệu vào PostGIS với hệ tọa độ EPSG:4326 và tạo index không gian GiST.
2. WHEN một lớp được tạo trong PostGIS THEN hệ thống SHALL gọi GeoServer REST để publish layer trong workspace/datastore đã cấu hình.
3. WHEN người dùng cập nhật style của lớp THEN hệ thống SHALL áp dụng SLD tương ứng trên GeoServer.
4. WHEN một lớp được xóa THEN hệ thống SHALL unpublish khỏi GeoServer và xóa metadata trong PostGIS.
5. WHEN người dùng gán mức truy cập cho lớp (public/internal/chuyên ngành) THEN hệ thống SHALL lưu mức truy cập để middleware kiểm soát.
6. IF kết nối GeoServer thất bại THEN hệ thống SHALL ghi log lỗi và trả về thông điệp lỗi rõ ràng, không làm hỏng metadata PostGIS.

### Requirement 3: Phục vụ bản đồ qua proxy có phân quyền

**User Story:** Là người dùng WebGIS/MobileGIS, tôi muốn truy cập lớp bản đồ theo đúng quyền của mình mà không lộ GeoServer ra ngoài.

#### Acceptance Criteria

1. WHEN client gọi endpoint proxy WMS/WFS THEN hệ thống SHALL kiểm tra JWT và quyền truy cập lớp trước khi forward tới GeoServer nội bộ.
2. WHEN người dùng yêu cầu lớp công khai THEN hệ thống SHALL cho phép truy cập kể cả khi chưa đăng nhập (optionalAuth).
3. WHEN người dùng yêu cầu lớp nội bộ/chuyên ngành mà không đủ quyền THEN hệ thống SHALL trả về 403.
4. WHEN forward request THEN hệ thống SHALL không expose URL/credential GeoServer cho client.
5. WHEN GeoServer trả tile/ảnh THEN hệ thống SHALL truyền lại nguyên content-type và hỗ trợ cache header phù hợp.

### Requirement 4: API dữ liệu bản đồ

**User Story:** Là quản trị hệ thống, tôi muốn tạo và chia sẻ API dữ liệu bản đồ có phân quyền cho hệ thống chuyên ngành tích hợp.

#### Acceptance Criteria

1. WHEN system_admin tạo một API dữ liệu bản đồ THEN hệ thống SHALL phát sinh khóa/định danh API và lưu cấu hình lớp được phép truy cập.
2. WHEN một API được chia sẻ THEN hệ thống SHALL cho phép gán phạm vi quyền (lớp nào, thao tác nào).
3. WHEN client gọi API bằng khóa hợp lệ THEN hệ thống SHALL trả dữ liệu trong phạm vi được phép.
4. IF khóa API bị thu hồi hoặc hết hạn THEN hệ thống SHALL từ chối truy cập.

### Requirement 5: Quản trị ảnh vệ tinh

**User Story:** Là Sở NN&MT, tôi muốn quản lý và khai thác ảnh vệ tinh phục vụ giám sát.

#### Acceptance Criteria

1. WHEN người dùng có quyền thêm ảnh vệ tinh THEN hệ thống SHALL lưu metadata ảnh (nguồn, thời gian, vùng, loại) vào catalog.
2. WHEN người dùng tìm kiếm ảnh theo thời gian/vùng/loại THEN hệ thống SHALL trả về danh sách phù hợp.
3. WHEN ảnh được đánh dấu công khai THEN người dân SHALL xem được ảnh đó.
4. WHEN người dùng so sánh hiện trạng giữa hai thời điểm THEN hệ thống SHALL hỗ trợ trả về dữ liệu cho việc so sánh.

### Requirement 6: Dữ liệu thời tiết

**User Story:** Là Sở NN&MT, tôi muốn theo dõi dữ liệu thời tiết phục vụ cảnh báo cháy.

#### Acceptance Criteria

1. WHEN cronjob đồng bộ thời tiết chạy (mặc định 1 giờ/lần) THEN hệ thống SHALL lấy nhiệt độ, mưa, gió, độ ẩm từ nguồn (ERA5-Land/OpenWeather) và lưu vào `gis.weather_data`.
2. WHEN client yêu cầu thời tiết hiện tại hoặc lịch sử theo vùng THEN hệ thống SHALL trả dữ liệu tương ứng.
3. WHEN dữ liệu thời tiết được cập nhật THEN nó SHALL sẵn sàng làm đầu vào cho tính chỉ số FireRisk.

### Requirement 7: Pipeline dự báo cháy rừng (GEE)

**User Story:** Là Sở NN&MT, tôi muốn hệ thống tự động tính nguy cơ cháy rừng từ ảnh vệ tinh và phân cấp cảnh báo.

#### Acceptance Criteria

1. WHEN pipeline GEE chạy THEN hệ thống SHALL tính NDVI, NDMI, NBR từ Sentinel-2 và LST từ MODIS cho vùng Kon Tum.
2. WHEN các chỉ số được tính THEN hệ thống SHALL tổng hợp `FireRisk` theo trọng số (LST, độ khô, gió, mưa, độ dốc) và phân 5 cấp cảnh báo.
3. WHEN kết quả nguy cơ được tạo THEN hệ thống SHALL ghi vào bảng `fire.forest_fire_warning` (geom Polygon 4326, risk_level, risk_score, thời gian, vùng).
4. WHEN bản đồ nguy cơ tổng hợp được cập nhật (mặc định 1 ngày/lần) THEN GeoServer SHALL publish/refresh lớp tương ứng.
5. WHERE vùng tính toán lớn, hệ thống SHALL xử lý GEE bất đồng bộ (hàng đợi/task), KHÔNG chạy đồng bộ trong vòng đời một HTTP request.
6. IF GEE khởi tạo hoặc xác thực thất bại THEN hệ thống SHALL ghi log và bỏ qua chu kỳ đó mà không làm sập tiến trình.

### Requirement 8: Điểm cháy thực tế NASA FIRMS

**User Story:** Là Sở NN&MT, tôi muốn xem điểm cháy đang hoạt động để xác nhận nguy cơ.

#### Acceptance Criteria

1. WHEN cronjob FIRMS chạy (mặc định 1–3 giờ/lần) THEN hệ thống SHALL lấy điểm cháy VIIRS/MODIS và lưu vào `fire.active_fire_point` (geom Point 4326).
2. WHEN một vùng có nguy cơ cao VÀ tồn tại điểm FIRMS gần đó THEN hệ thống SHALL đánh dấu cảnh báo ưu tiên cao.
3. WHEN cảnh báo ưu tiên cao được tạo THEN hệ thống SHALL đẩy thông báo realtime (WebSocket) và push (FCM) tới thiết bị liên quan.

### Requirement 9: API cảnh báo cháy cho bản đồ

**User Story:** Là người dùng WebGIS/MobileGIS, tôi muốn xem lớp cảnh báo cháy và chi tiết popup.

#### Acceptance Criteria

1. WHEN client gọi `/api/v1/fire-risk/latest` THEN hệ thống SHALL trả GeoJSON các vùng nguy cơ kèm `risk_level` để tô màu trên Mapbox.
2. WHEN client yêu cầu lịch sử cảnh báo theo khoảng thời gian THEN hệ thống SHALL trả dữ liệu tương ứng.
3. WHEN người dùng chọn một vùng cảnh báo THEN hệ thống SHALL cung cấp dữ liệu popup (cấp, chỉ số, LST, NDMI, gió, mưa 7 ngày, thời gian, khuyến nghị).
4. WHEN người dân (chưa đăng nhập) truy cập cảnh báo công khai THEN hệ thống SHALL cho phép xem.

### Requirement 10: Thống kê & phân tích không gian

**User Story:** Là Sở NN&MT/UBND tỉnh, tôi muốn xem thống kê và phân tích thay đổi rừng.

#### Acceptance Criteria

1. WHEN người dùng yêu cầu thống kê diện tích lớp phủ THEN hệ thống SHALL trả số liệu theo huyện và theo thời gian.
2. WHEN người dùng chạy phân tích thay đổi rừng THEN hệ thống SHALL so sánh hai thời điểm và trả vùng thay đổi.
3. WHEN người dùng phân tích khoảng cách dân cư–rừng THEN hệ thống SHALL dùng truy vấn không gian PostGIS để tính toán.
4. WHEN UBND tỉnh xem dashboard THEN hệ thống SHALL cung cấp số liệu/biểu đồ điều hành cấp tỉnh.

### Requirement 11: Tin tức, báo cáo/văn bản, bản đồ PDF (CMS)

**User Story:** Là Sở NN&MT, tôi muốn đăng tin tức và quản lý báo cáo/văn bản/bản đồ PDF chuyên ngành.

#### Acceptance Criteria

1. WHEN người dùng có quyền tạo/sửa/xóa tin tức THEN hệ thống SHALL lưu và phục vụ nội dung.
2. WHEN người dân đọc tin tức THEN hệ thống SHALL cho phép tìm kiếm và bình luận.
3. WHEN người dùng có quyền quản lý báo cáo/văn bản THEN hệ thống SHALL hỗ trợ thêm/xóa và phân loại theo nghiệp vụ/công khai.
4. WHEN người dùng quản lý bản đồ PDF THEN hệ thống SHALL cho phép thêm/sửa/xóa và cho người dùng tải về theo quyền.

### Requirement 12: Gửi phản ánh & cập nhật hiện trạng (MobileGIS)

**User Story:** Là người dân, tôi muốn gửi phản ánh kèm ảnh vi phạm và cập nhật hiện trạng tại thực địa.

#### Acceptance Criteria

1. WHEN người dân gửi phản ánh THEN hệ thống SHALL lưu nội dung, vị trí GPS, ảnh đính kèm và trạng thái ban đầu là "mới".
2. WHEN so_nnmt/admin xử lý phản ánh THEN hệ thống SHALL cập nhật trạng thái (mới → đang kiểm tra → đã xử lý) và lưu lịch sử.
3. WHEN người dùng MobileGIS cập nhật hiện trạng rừng THEN hệ thống SHALL lưu cập nhật kèm tọa độ và ảnh.
4. WHEN UBND tỉnh theo dõi THEN hệ thống SHALL cung cấp tổng hợp phản ánh toàn tỉnh.

### Requirement 13: Thông báo realtime & đẩy (MobileGIS)

**User Story:** Là người dùng MobileGIS, tôi muốn nhận cảnh báo gần vị trí của mình.

#### Acceptance Criteria

1. WHEN thiết bị đăng ký push token THEN hệ thống SHALL lưu token gắn với người dùng/thiết bị.
2. WHEN có cảnh báo cháy gần vị trí GPS đã biết của người dùng THEN hệ thống SHALL gửi thông báo đẩy (FCM).
3. WHEN có sự kiện cảnh báo mới THEN hệ thống SHALL phát qua WebSocket tới client đang kết nối.

### Requirement 14: Bảo mật & vận hành

**User Story:** Là quản trị hệ thống, tôi muốn hệ thống an toàn và vận hành ổn định.

#### Acceptance Criteria

1. WHEN một endpoint ghi dữ liệu được gọi THEN hệ thống SHALL yêu cầu JWT hợp lệ và kiểm tra quyền theo vai trò.
2. WHEN file cấu hình chứa secret THEN `.env` SHALL nằm trong `.gitignore` và không được commit.
3. WHEN GeoServer được triển khai THEN nó SHALL không expose trực tiếp ra internet; truy cập đi qua proxy của Express.
4. WHEN cronjob ingestion chạy THEN chỉ một worker singleton SHALL thực thi để tránh trùng lặp.
5. WHEN có truy vấn không gian lớn THEN bảng SHALL có index GiST trên cột geom.
