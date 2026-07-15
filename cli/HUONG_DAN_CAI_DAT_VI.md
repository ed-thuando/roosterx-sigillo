# Hướng dẫn cài đặt Sigillo CLI (bản nội bộ)

CLI này dùng để lấy secret từ server Sigillo nội bộ (**https://env.shotpix.app**)
và bơm vào tiến trình khi chạy app. **Không dùng bản `npm install -g sigillo`
ngoài kia** — bản đó trỏ tới server công khai, không phải server của mình.

---

## 1. Cài đặt

### Cách A — Nhận sẵn file binary (đơn giản nhất)
Xin file `rx` đã build từ người quản lý, rồi:
```sh
mkdir -p ~/.local/bin
cp ~/Downloads/rx ~/.local/bin/rx
chmod +x ~/.local/bin/rx

# Đảm bảo ~/.local/bin nằm trong PATH (thêm vào ~/.zshrc nếu chưa có):
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# macOS có thể chặn app chưa ký — chạy 1 lần:
xattr -d com.apple.quarantine ~/.local/bin/rx 2>/dev/null || true

rx --version
```

### Cách B — Tự build từ mã nguồn
Cần **Zig 0.15.1** (KHÔNG dùng 0.16 — có breaking changes; 0.14 quá cũ) + **pnpm**.
```sh
# 1. Cài Zig 0.15.1 (macOS arm64):
curl -sL -o /tmp/zig.tar.xz https://ziglang.org/download/0.15.1/zig-aarch64-macos-0.15.1.tar.xz
mkdir -p ~/zig-0.15.1 && tar -xJf /tmp/zig.tar.xz -C ~/zig-0.15.1 --strip-components=1
export PATH="$HOME/zig-0.15.1:$PATH"     # thêm vào ~/.zshrc để dùng lâu dài
zig version                              # phải in 0.15.1

# 2. Build:
git clone <repo-noi-bo>/roosterx-sigillo.git
cd roosterx-sigillo/cli
zig build -Doptimize=ReleaseFast
mkdir -p ~/.local/bin
cp zig-out/bin/rx ~/.local/bin/rx
codesign --force --sign - ~/.local/bin/rx   # macOS
chmod +x ~/.local/bin/rx
hash -r
rx --version
```

---

## 2. Đăng nhập

```sh
rx login
```
- Server mặc định đã là **https://env.shotpix.app** (build sẵn) — **không cần** `--api-url`.
  Chỉ khi muốn trỏ server khác mới cần: `rx login --api-url <url>`.
- Lệnh sẽ hiện một mã (device code) + link `https://env.shotpix.app/device`.
- Mở link trên trình duyệt, đăng nhập Google, nhập mã để duyệt.
- Token được lưu tại `~/.rx/config.json`.

> Cách khác (dùng token sẵn): tạo thủ công `~/.rx/config.json`:
> ```json
> { "default": { "api-url": "https://env.shotpix.app", "token": "<token-cua-ban>" } }
> ```
> (`token` lấy từ mục Tokens trong dashboard của project.)

---

## 3. Sử dụng

```sh
# Chạy lệnh với secret được bơm vào (secret bị che trong log mặc định):
rx run -- next dev

# Chỉ định project + môi trường:
rx run --project <ten-project> --env dev -- next dev

# Ví dụ:
rx run --project PDF_Reader --env prod -- node server.js
```

---

## 4. Bảo mật — quan trọng
- Ai truy cập được secret **không phụ thuộc vào file CLI**, mà phụ thuộc vào
  **token** + đăng nhập trên server nội bộ.
- Bản CLI ngoài (`npm i -g sigillo`) **không lấy được** secret của mình vì:
  1. nó trỏ tới server công khai (khác `env.shotpix.app`),
  2. không có token do server mình cấp → bị từ chối (401).
- Chỉ cấp token cho người/máy tin cậy. Giữ `~/.rx/config.json` riêng tư.
