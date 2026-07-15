# Hướng dẫn sử dụng Sigillo (Web + CLI)

Sigillo là hệ thống quản lý **secret** (biến môi trường, API key, mật khẩu…) nội bộ.
Bạn quản lý secret trên **web**, và dùng **CLI** để bơm secret vào ứng dụng khi chạy —
không cần copy `.env` thủ công, không lộ secret trong log.

- **Server nội bộ (dùng cái này):** https://env.shotpix.app
- ⚠️ Không dùng bản công khai `sigillo.dev` / `npm i -g sigillo` — khác server, không thấy secret của mình.

---

## Phần 1 — Dùng trên Web (https://env.shotpix.app)

### 1. Đăng nhập
Mở https://env.shotpix.app → bấm **Login with Google** → đăng nhập bằng tài khoản công ty.

### 2. Cấu trúc: Tổ chức → Dự án → Môi trường
- **Organization (Tổ chức):** nhóm cao nhất. Đổi org bằng nút chọn org ở góc trái sidebar;
  tạo org mới bằng **Add organization**.
- **Project (Dự án):** mỗi app/dịch vụ là 1 project. Tạo bằng **New project** ở sidebar.
  Mỗi project tạo sẵn 3 môi trường: **development**, **preview**, **production**.
- **Environment (Môi trường):** nơi chứa secret. Cùng 1 secret có thể có giá trị khác nhau
  giữa dev và prod.

### 3. Các tab trong 1 project
- **Secrets:** thêm / sửa / xóa secret theo từng môi trường (chọn env ở đầu trang).
  Giá trị mặc định bị che; bấm để hiện.
- **Tokens** *(chỉ admin):* tạo **API token** cho CLI hoặc CI/CD. Mỗi token gắn với 1 môi trường.
  Copy token ngay khi tạo (chỉ hiện 1 lần).
- **Access:** phân quyền thành viên theo từng môi trường — **None / Read / Write**.
  Nút thùng rác cho phép **xóa thành viên khỏi project** hoặc **khỏi tổ chức** (hộp thoại sẽ hỏi).
- **Settings:** xóa project (cần project-admin), xóa tổ chức (cần org-admin).

### 4. Vai trò (quyền)
| Vai trò | Quyền |
|---|---|
| **org-admin** | Toàn quyền trong tổ chức |
| **project-admin** | Quản lý project: secret, token, thành viên, môi trường |
| **member** | Đọc **và** ghi secret |
| **viewer** | Chỉ đọc secret |

> Tab / nút bạn không có quyền sẽ **tự động ẩn** (vd member không thấy tab Tokens).

---

## Phần 2 — Dùng CLI

### 1. Cài đặt
Xem file **`cli/HUONG_DAN_CAI_DAT_VI.md`** (nhận binary sẵn, hoặc tự build bằng **Zig 0.15.1**).
Sau khi cài, kiểm tra:
```sh
rx --version
```

### 2. Đăng nhập
```sh
rx login
```
- Server mặc định đã là **https://env.shotpix.app** (build sẵn) — **không cần** `--api-url`.
  Chỉ khi muốn trỏ server khác mới cần: `rx login --api-url <url>`.
- CLI hiện 1 **device code** + link. Mở link, đăng nhập Google, nhập code để duyệt.
- Token + api-url được lưu ở `~/.rx/config.json` (theo thư mục — "scope").
- Kiểm tra đăng nhập: `rx me`

> Cách khác: đặt biến môi trường `RX_TOKEN=sig_xxx` (và `RX_API_URL` nếu dùng server khác)
> (token lấy từ tab **Tokens** trên web).

### 3. Chọn project + môi trường mặc định cho thư mục hiện tại
```sh
rx setup --project <project-id> --env dev
```
Lưu vào `~/.rx` (không lưu trong repo). Sau đó không cần gõ `--project/--env` mỗi lần.

### 4. Chạy ứng dụng với secret được bơm vào
```sh
# Dùng project/env đã setup:
rx run -- next dev

# Hoặc chỉ định trực tiếp:
rx run --project <id> --env prod -- node server.js

# Chạy 1 câu lệnh shell:
rx run --command "npm start"
```
Output của app được **che secret** mặc định. Muốn tắt che (cẩn thận): `--disable-redaction`.

### 5. Ghi secret ra file (khi công cụ cần đọc `.env`)
```sh
rx run --mount .env -- <lệnh>
# Định dạng khác: --mount-format env|json|yaml|docker|dotnet-json
```

### 6. Xem secret
```sh
rx secrets                      # liệt kê secret của env đang cấu hình
rx secrets get <TEN>            # lấy giá trị 1 secret
```

### 7. Lệnh hữu ích khác
```sh
rx me                           # xem user hiện tại
rx logout                       # đăng xuất (xóa auth của scope)
rx projects                     # liệt kê project
rx environments                 # liệt kê môi trường của project
```

---

## Phần 3 — Luồng dùng điển hình
1. **Web:** admin tạo project → thêm secret vào từng môi trường → tạo API token (tab Tokens) hoặc mời thành viên (tab Access).
2. **CLI (máy dev):** `rx login` → `rx setup --project <id> --env dev` → `rx run -- <lệnh chạy app>`.
3. **CI/CD:** đặt `RX_TOKEN` (token từ web; thêm `RX_API_URL` nếu dùng server khác) → `rx run -- <build/deploy>`.

## Bảo mật
- Quyền truy cập secret phụ thuộc vào **token + tài khoản trên server nội bộ**, không phụ thuộc file CLI.
- Chỉ cấp token cho người/máy tin cậy. Giữ `~/.rx/config.json` riêng tư.
- Token gắn với 1 môi trường → cấp token prod hạn chế, token dev thoải mái hơn.
