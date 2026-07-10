# Hướng dẫn cài đặt Sigillo CLI (bản nội bộ)

CLI này dùng để lấy secret từ server Sigillo nội bộ (**https://env.shotpix.app**)
và bơm vào tiến trình khi chạy app. **Không dùng bản `npm install -g sigillo`
ngoài kia** — bản đó trỏ tới server công khai, không phải server của mình.

---

## 1. Cài đặt

### Cách A — Nhận sẵn file binary (đơn giản nhất)
Xin file `sigillo` đã build từ người quản lý, rồi:
```sh
mkdir -p ~/.local/bin
cp ~/Downloads/sigillo ~/.local/bin/sigillo
chmod +x ~/.local/bin/sigillo

# Đảm bảo ~/.local/bin nằm trong PATH (thêm vào ~/.zshrc nếu chưa có):
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# macOS có thể chặn app chưa ký — chạy 1 lần:
xattr -d com.apple.quarantine ~/.local/bin/sigillo 2>/dev/null || true

sigillo --version
```

### Cách B — Tự build từ mã nguồn
Cần **Zig** (đúng phiên bản repo dùng — hỏi người quản lý; hiện Zig 0.16 CHƯA hợp)
và **pnpm**.
```sh
git clone <repo-noi-bo>/roosterx-sigillo.git
cd roosterx-sigillo/cli
pnpm install
pnpm install:local        # build binary + cài vào ~/.local/bin/sigillo
hash -r
sigillo --version
```

---

## 2. Đăng nhập (trỏ đúng server nội bộ)

```sh
# Trỏ CLI tới server nội bộ:
sigillo login --api-url https://env.shotpix.app
```
- Lệnh sẽ hiện một mã (device code) + link `https://env.shotpix.app/device`.
- Mở link trên trình duyệt, đăng nhập Google, nhập mã để duyệt.
- Token được lưu tại `~/.sigillo/config.json`.

> Nếu `login` chưa hỗ trợ `--api-url`, tạo thủ công `~/.sigillo/config.json`:
> ```json
> { "default": { "api-url": "https://env.shotpix.app", "token": "<token-cua-ban>" } }
> ```
> (`token` lấy từ mục Tokens trong dashboard của project.)

---

## 3. Sử dụng

```sh
# Chạy lệnh với secret được bơm vào (secret bị che trong log mặc định):
sigillo run -- next dev

# Chỉ định project + môi trường:
sigillo run --project <ten-project> --env dev -- next dev

# Ví dụ:
sigillo run --project PDF_Reader --env prod -- node server.js
```

---

## 4. Bảo mật — quan trọng
- Ai truy cập được secret **không phụ thuộc vào file CLI**, mà phụ thuộc vào
  **token** + đăng nhập trên server nội bộ.
- Bản CLI ngoài (`npm i -g sigillo`) **không lấy được** secret của mình vì:
  1. nó trỏ tới server công khai (khác `env.shotpix.app`),
  2. không có token do server mình cấp → bị từ chối (401).
- Chỉ cấp token cho người/máy tin cậy. Giữ `~/.sigillo/config.json` riêng tư.
