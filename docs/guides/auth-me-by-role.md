# GET /auth/me?lang=vi — kết quả theo từng role

## 1. Nguồn và thời điểm kiểm tra

- Endpoint: `https://apikontum.tourismpj.pro.vn/api/v1/auth/me?lang=vi`.
- Method: `GET`; header xác thực: `Authorization: Bearer <access_token>`.
- Thời điểm gọi API: **07/10/2026, 21:55:24 (UTC+7)**.
- Timestamp gốc: `2026-10-07T14:55:24.774Z`.
- Tài liệu lập từ bằng chứng đã lưu, không gọi lại API lúc tạo tài liệu.
- Đăng nhập thật 4 tài khoản mẫu bằng phiên riêng. Không chứa mật khẩu hoặc token.
- Đây là snapshot quyền thực tế, không phải đặc tả quyền mục tiêu.

## 2. Tổng hợp tài khoản

| Tài khoản | Role từ API | Login | /auth/me | must_change_password | Vào Admin |
|---|---|---|---|---|---|
| admin@kontum.gov.vn | `system_admin` | 200 | 200 | false | Có; bypass quyền hiện có |
| ubnd@kontum.gov.vn | `ubnd_tinh` | 200 | 200 | false | Có; theo quyền được cấp |
| sonn@kontum.gov.vn | `so_nnmt` | 200 | 200 | false | Có; theo quyền được cấp |
| citizen@kontum.gov.vn | `citizen` | 200 | 200 | false | Không |

## 3. Cách đọc dữ liệu

- JSON bên dưới chỉ trích `role.code`, toàn bộ `role.permissions` và `must_change_password` đã ghi nhận, không phải response đầy đủ.
- Không tự điền `id`, `full_name`, `phone`, `avatar_url` hoặc metadata chưa lưu trong bằng chứng.
- Với role không có bypass: chỉ action `true` được cấp; action thiếu hoặc `false` không được cấp.
- Hậu tố `_own` chỉ dữ liệu của chính người dùng. `read` không bao gồm quyền tạo/sửa/xóa/duyệt/quản lý/kiểm chứng.
- `system_admin` có bypass theo middleware/helper hiện có; quyền hiệu lực rộng hơn JSON permissions.
- `/auth/me` 200 không đồng nghĩa vào được Admin: citizen vẫn bị từ chối.

## 4.1. Quản trị hệ thống — system_admin

Tài khoản: `admin@kontum.gov.vn`. `/auth/me`: **200**. `must_change_password`: `false`.

### Quyền được trả về

| Nhóm quyền | Action có giá trị true |
|---|---|
| `news` | `read`, `create`, `delete`, `update`, `publish` |
| `roles` | `read`, `manage`, `update` |
| `users` | `read`, `create`, `delete`, `update`, `read_own`, `update_own`, `change_role`, `change_status`, `reset_password` |
| `comments` | `read`, `create`, `delete`, `approve`, `delete_own` |
| `documents` | `read`, `create`, `delete`, `update`, `publish` |
| `fire_risk` | `read`, `manage` |
| `device_tokens` | `read`, `delete`, `read_own`, `create_own`, `delete_own` |
| `notifications` | `read`, `send`, `create`, `delete`, `update`, `read_own`, `delete_own` |
| `news_translations` | `read`, `create`, `delete`, `update` |
| `notification_reads` | `create`, `read_own`, `update_own` |
| `document_translations` | `read`, `create`, `delete`, `update` |
| `forest_classification` | `read`, `manage` |

### JSON trích từ kết quả kiểm tra

```json
{
  "role": {
    "code": "system_admin",
    "permissions": {
      "news": {
        "read": true,
        "create": true,
        "delete": true,
        "update": true,
        "publish": true
      },
      "roles": {
        "read": true,
        "manage": true,
        "update": true
      },
      "users": {
        "read": true,
        "create": true,
        "delete": true,
        "update": true,
        "read_own": true,
        "update_own": true,
        "change_role": true,
        "change_status": true,
        "reset_password": true
      },
      "comments": {
        "read": true,
        "create": true,
        "delete": true,
        "approve": true,
        "delete_own": true
      },
      "documents": {
        "read": true,
        "create": true,
        "delete": true,
        "update": true,
        "publish": true
      },
      "fire_risk": {
        "read": true,
        "manage": true
      },
      "device_tokens": {
        "read": true,
        "delete": true,
        "read_own": true,
        "create_own": true,
        "delete_own": true
      },
      "notifications": {
        "read": true,
        "send": true,
        "create": true,
        "delete": true,
        "update": true,
        "read_own": true,
        "delete_own": true
      },
      "news_translations": {
        "read": true,
        "create": true,
        "delete": true,
        "update": true
      },
      "notification_reads": {
        "create": true,
        "read_own": true,
        "update_own": true
      },
      "document_translations": {
        "read": true,
        "create": true,
        "delete": true,
        "update": true
      },
      "forest_classification": {
        "read": true,
        "manage": true
      }
    }
  },
  "must_change_password": false
}
```

### Lưu ý

JSON thiếu một số nhóm như statistics/map_layers/map_apis/weather/pdf_maps/feedback/field_measurements, nhưng bypass hiện có vẫn cho phép system_admin. GET các nhóm tương ứng đã trả 200.

## 4.2. UBND tỉnh — ubnd_tinh

Tài khoản: `ubnd@kontum.gov.vn`. `/auth/me`: **200**. `must_change_password`: `false`.

### Quyền được trả về

| Nhóm quyền | Action có giá trị true |
|---|---|
| `news` | `read` |
| `users` | `read` |
| `comments` | `read` |
| `map_apis` | `read` |
| `documents` | `read` |
| `fire_risk` | `read` |
| `device_tokens` | `read_own`, `create_own`, `delete_own` |
| `notifications` | `read_own`, `delete_own` |
| `notification_reads` | `create`, `read_own`, `update_own` |
| `forest_classification` | `read` |

### JSON trích từ kết quả kiểm tra

```json
{
  "role": {
    "code": "ubnd_tinh",
    "permissions": {
      "news": {
        "read": true
      },
      "users": {
        "read": true
      },
      "comments": {
        "read": true
      },
      "map_apis": {
        "read": true
      },
      "documents": {
        "read": true
      },
      "fire_risk": {
        "read": true
      },
      "device_tokens": {
        "read_own": true,
        "create_own": true,
        "delete_own": true
      },
      "notifications": {
        "read_own": true,
        "delete_own": true
      },
      "notification_reads": {
        "create": true,
        "read_own": true,
        "update_own": true
      },
      "forest_classification": {
        "read": true
      }
    }
  },
  "must_change_password": false
}
```

### Lưu ý

Chỉ đọc API bản đồ, rừng/cháy, tin tức, bình luận, văn bản, người dùng. Không có manage rừng/cháy, approve/delete bình luận hoặc notifications.send.

Chưa có các nhóm `statistics`, `map_layers`, `pdf_maps`, `weather`, `feedback`, `field_measurements` trong JSON quyền.

## 4.3. Sở NN&MT — so_nnmt

Tài khoản: `sonn@kontum.gov.vn`. `/auth/me`: **200**. `must_change_password`: `false`.

### Quyền được trả về

| Nhóm quyền | Action có giá trị true |
|---|---|
| `news` | `read`, `create`, `publish` |
| `users` | `read`, `create`, `delete`, `update`, `change_status`, `reset_password` |
| `comments` | `read` |
| `map_apis` | `read` |
| `documents` | `read`, `create`, `delete`, `update`, `publish` |
| `fire_risk` | `read`, `manage` |
| `device_tokens` | `read_own`, `create_own`, `delete_own` |
| `notifications` | `send`, `read_own`, `delete_own` |
| `news_translations` | `read`, `create` |
| `notification_reads` | `create`, `read_own`, `update_own` |
| `document_translations` | `read`, `create`, `delete`, `update` |
| `forest_classification` | `read`, `manage` |

### JSON trích từ kết quả kiểm tra

```json
{
  "role": {
    "code": "so_nnmt",
    "permissions": {
      "news": {
        "read": true,
        "create": true,
        "publish": true
      },
      "users": {
        "read": true,
        "create": true,
        "delete": true,
        "update": true,
        "change_status": true,
        "reset_password": true
      },
      "comments": {
        "read": true
      },
      "map_apis": {
        "read": true
      },
      "documents": {
        "read": true,
        "create": true,
        "delete": true,
        "update": true,
        "publish": true
      },
      "fire_risk": {
        "read": true,
        "manage": true
      },
      "device_tokens": {
        "read_own": true,
        "create_own": true,
        "delete_own": true
      },
      "notifications": {
        "send": true,
        "read_own": true,
        "delete_own": true
      },
      "news_translations": {
        "read": true,
        "create": true
      },
      "notification_reads": {
        "create": true,
        "read_own": true,
        "update_own": true
      },
      "document_translations": {
        "read": true,
        "create": true,
        "delete": true,
        "update": true
      },
      "forest_classification": {
        "read": true,
        "manage": true
      }
    }
  },
  "must_change_password": false
}
```

### Lưu ý

Tin tức có read/create/publish, không có update/delete. Người dùng không có change_role. Bình luận/API bản đồ chỉ read. Rừng/cháy có read/manage nhưng không có ground_truth. Có notifications.send.

Chưa có các nhóm `statistics`, `map_layers`, `pdf_maps`, `weather`, `feedback`, `field_measurements` trong JSON quyền.

## 4.4. Người dân — citizen

Tài khoản: `citizen@kontum.gov.vn`. `/auth/me`: **200**. `must_change_password`: `false`.

### Quyền được trả về

| Nhóm quyền | Action có giá trị true |
|---|---|
| `news` | `read` |
| `users` | `read_own`, `update_own` |
| `comments` | `read`, `create`, `delete_own` |
| `documents` | `read` |
| `fire_risk` | `read` |
| `device_tokens` | `read_own`, `create_own`, `delete_own` |
| `notifications` | `read_own`, `delete_own` |
| `notification_reads` | `create`, `read_own`, `update_own` |
| `forest_classification` | `read` |

### JSON trích từ kết quả kiểm tra

```json
{
  "role": {
    "code": "citizen",
    "permissions": {
      "news": {
        "read": true
      },
      "users": {
        "read_own": true,
        "update_own": true
      },
      "comments": {
        "read": true,
        "create": true,
        "delete_own": true
      },
      "documents": {
        "read": true
      },
      "fire_risk": {
        "read": true
      },
      "device_tokens": {
        "read_own": true,
        "create_own": true,
        "delete_own": true
      },
      "notifications": {
        "read_own": true,
        "delete_own": true
      },
      "notification_reads": {
        "create": true,
        "read_own": true,
        "update_own": true
      },
      "forest_classification": {
        "read": true
      }
    }
  },
  "must_change_password": false
}
```

### Lưu ý

Hồ sơ chỉ read_own/update_own; bình luận có read/create/delete_own, không có duyệt/xóa của người khác. Không được vào Admin.

## 5. GET đối chiếu trong cùng lượt audit

| Endpoint (base /api/v1) | system_admin | ubnd_tinh | so_nnmt | citizen |
|---|---|---|---|---|
| `/auth/me` | 200 | 200 | 200 | 200 |
| `/stats/dashboard` | 200 | 403 | 403 | 403 |
| `/forest-classification/latest` | 200 | 200 | 200 | 200 |
| `/forest-classification/history` | 200 | 403 | 200 | 403 |
| `/forest-classification/ground-truth/points` | 200 | 403 | 403 | 403 |
| `/fire-risk/latest` | 200 | 200 | 200 | 200 |
| `/fire-risk/history` | 200 | 403 | 200 | 403 |
| `/fire-risk/ground-truth/points` | 200 | 403 | 403 | 403 |
| `/admin/users` | 200 | 200 | 200 | 403 |
| `/admin/news` | 200 | 200 | 200 | 200 |
| `/documents` | 200 | 200 | 200 | 200 |
| `/map/layers` | 200 | 200 | 200 | 200 |
| `/map/layer-groups` | 200 | 200 | 200 | 200 |
| `/pdf-maps` | 200 | 200 | 200 | 200 |
| `/admin/comments` | 200 | 200 | 200 | 200 |
| `/admin/feedback` | 200 | 403 | 403 | 403 |
| `/map-apis` | 200 | 200 | 200 | 403 |
| `/field-measurements` | 200 | 403 | 403 | 403 |
| `/monitored-areas` | 200 | 403 | 403 | 403 |
| `/weather/layers` | 200 | 200 | 200 | 200 |
| `/notifications` | 200 | 200 | 200 | 200 |
| `/notifications/unread-count` | 200 | 200 | 200 | 200 |

## 6. Diễn giải và giới hạn

- 88 GET: **64 HTTP 200, 24 HTTP 403, không có HTTP 401** với phiên mới.
- 401 là phiên không hợp lệ/hết hạn; 403 là thiếu quyền sau xác thực.
- GET công khai `/map/layers`, `/pdf-maps`, `/weather/layers` trả 200 không tạo quyền quản trị/import.
- Citizen gọi `/admin/news` và `/admin/comments` được 200 theo quyền đọc tài nguyên backend hiện có; frontend vẫn chặn vào Admin. Nếu các GET này phải hoàn toàn nội bộ, cần rà soát authorization backend riêng.
- Chỉ kiểm tra 4 tài khoản mẫu, không phải mọi account trong DB. Không thử POST/PATCH/DELETE nghiệp vụ production.
- Không sửa quyền DB hoặc triển khai frontend khi lập tài liệu.
- Khi backend đổi quyền, cần gọi lại `/auth/me` từng role và cập nhật timestamp cùng JSON.
