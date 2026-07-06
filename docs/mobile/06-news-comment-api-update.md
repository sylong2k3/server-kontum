# Mobile API Update Log: News Comments by Slug

Ngày cập nhật: 2026-07-05

Tài liệu này ghi lại thay đổi backend liên quan đến news/comment để mobile cập nhật API mapping.

## 1. Public/mobile comment đổi từ newsId sang slug

Trước đây:

```txt
GET    /api/v1/news/:id/comments
POST   /api/v1/news/:id/comments
DELETE /api/v1/news/:id/comments/:commentId
```

Hiện tại:

```txt
GET    /api/v1/news/:slug/comments
POST   /api/v1/news/:slug/comments
DELETE /api/v1/news/:slug/comments/:commentId
```

Backend resolve nội bộ:

```txt
slug -> news.id -> comments.news_id
```

Mobile chỉ cần truyền `slug` lấy từ API danh sách/chi tiết tin tức.

## 2. Lấy danh sách comment theo slug

```http
GET /api/v1/news/{slug}/comments?page=1&limit=20
```

Auth:

- Không bắt buộc đăng nhập.
- Public chỉ nhận comment đã duyệt.
- Admin/moderator nếu gửi token/quyền phù hợp có thể thấy cả comment chưa duyệt.

Path params:

| Field | Type | Required | Note |
|---|---:|---:|---|
| `slug` | string | yes | Slug của tin tức |

Query params:

| Field | Type | Default | Note |
|---|---:|---:|---|
| `page` | number | `1` | Trang hiện tại |
| `limit` | number | `20` | Tối đa `100` |

Example:

```http
GET /api/v1/news/tin-moi-kon-tum/comments?page=1&limit=20
```

## 3. Tạo comment theo slug

```http
POST /api/v1/news/{slug}/comments
```

Auth:

- Bắt buộc đăng nhập.
- Cần quyền `comments.create`.

Body:

```json
{
  "content": "Nội dung bình luận"
}
```

Notes:

- `content` bắt buộc, độ dài `1..1000` ký tự.
- Backend strip HTML tags trước khi lưu.
- Comment mới mặc định `isApproved = false`, chờ duyệt.

Example:

```http
POST /api/v1/news/tin-moi-kon-tum/comments
Authorization: Bearer <token>
Content-Type: application/json

{
  "content": "Bài viết rất hữu ích"
}
```

## 4. Xóa comment của chính mình theo slug

```http
DELETE /api/v1/news/{slug}/comments/{commentId}
```

Auth:

- Bắt buộc đăng nhập.
- Citizen cần quyền `comments.delete_own`.

Path params:

| Field | Type | Required | Note |
|---|---:|---:|---|
| `slug` | string | yes | Slug của tin tức |
| `commentId` | number | yes | Id comment |

Example:

```http
DELETE /api/v1/news/tin-moi-kon-tum/comments/15
Authorization: Bearer <token>
```

## 5. Admin comment APIs

Các API này dùng cho trang quản trị.

```http
GET /api/v1/admin/comments?page=1&limit=20
GET /api/v1/admin/comments?newsId=123&page=1&limit=20
GET /api/v1/admin/comments/news/123?page=1&limit=20
GET /api/v1/admin/comments?approved=false
GET /api/v1/admin/comments?approved=true
PATCH /api/v1/admin/comments/{commentId}/approve
DELETE /api/v1/admin/comments/{commentId}
```

Body duyệt/từ chối:

```json
{
  "isApproved": true
}
```

Từ chối/ẩn:

```json
{
  "isApproved": false
}
```

Admin comment response có thêm:

- `newsTitle`
- `newsSlug`

## 6. Admin news list

Admin CRUD news đã có sẵn, bổ sung thêm route danh sách:

```http
GET /api/v1/admin/news?page=1&limit=20&lang=vi
```

Các route admin news hiện có:

```txt
GET    /api/v1/admin/news
POST   /api/v1/admin/news
GET    /api/v1/admin/news/:id
PATCH  /api/v1/admin/news/:id
PUT    /api/v1/admin/news/:id
DELETE /api/v1/admin/news/:id
```

## 7. Mobile cần sửa

Nếu đang gọi bằng `newsId`:

```dart
'/news/$newsId/comments'
```

Đổi sang:

```dart
'/news/$slug/comments'
```

Model news cần có field:

```dart
final String slug;
```

Repository/service mobile nên đổi signature:

```dart
getComments(String slug)
createComment(String slug, String content)
deleteComment(String slug, int commentId)
```

## 8. Backend files liên quan

- `src/routes/news.routes.js`
- `src/routes/comment.routes.js`
- `src/controllers/comment.controller.js`
- `src/services/comment.service.js`
- `src/repositories/comment.repository.js`
- `src/validators/comment.validator.js`
