#!/usr/bin/env bash
# macOS 앱(shooting-star.app) 빌드.
#   scripts/make-app.sh <app 경로> [dev|bundle] [--universal]
#   dev    : 이 저장소를 가리키는 앱 (install.sh 용, 코드를 고치면 바로 반영)
#   bundle : server.js/public 을 앱 안에 담은 배포용 앱 (CI/Release 용). Node 는 실행 시점에 찾는다.
set -euo pipefail
APP="$1"; MODE="${2:-dev}"; UNI="${3:-}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/package.json" | head -1)"
PORT="${SS_PORT:-4000}"

rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 아이콘
ICONSET="$(mktemp -d)/icon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$DIR/assets/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$DIR/assets/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"

# 네이티브 셸 (WKWebView)
SRC="$DIR/macos/ShootingStar.swift"; OUT="$APP/Contents/MacOS/shooting-star"
if [ "$UNI" = "--universal" ]; then
  T="$(mktemp -d)"
  swiftc -O -swift-version 5 -target arm64-apple-macos13.0  "$SRC" -o "$T/arm64"  -framework Cocoa -framework WebKit
  swiftc -O -swift-version 5 -target x86_64-apple-macos13.0 "$SRC" -o "$T/x86_64" -framework Cocoa -framework WebKit
  lipo -create "$T/arm64" "$T/x86_64" -output "$OUT"
else
  swiftc -O -swift-version 5 "$SRC" -o "$OUT" -framework Cocoa -framework WebKit
fi

if [ "$MODE" = bundle ]; then
  mkdir -p "$APP/Contents/Resources/app"
  cp -R "$DIR/server.js" "$DIR/package.json" "$DIR/public" "$APP/Contents/Resources/app/"
  printf '{"port":%s}\n' "$PORT" > "$APP/Contents/Resources/config.json"
  # 터미널용 CLI (brew cask 의 binary 가 이 파일을 `ss` 로 연결한다)
  cat > "$APP/Contents/Resources/ss" <<'SH'
#!/bin/sh
# shooting-star CLI: 번들된 서버를 Node 로 실행한다.
SELF="$0"; [ -L "$SELF" ] && SELF="$(readlink "$SELF")"
DIR="$(cd "$(dirname "$SELF")" && pwd -P)"
NODE=""
for n in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.asdf/shims/node" \
         "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"; do
  [ -n "$n" ] && [ -x "$n" ] && NODE="$n" && break
done
[ -n "$NODE" ] || { echo "Node.js 18 이상이 필요합니다: brew install node" >&2; exit 1; }
exec "$NODE" "$DIR/app/server.js" "$@"
SH
  chmod +x "$APP/Contents/Resources/ss"
else
  NODE="$(command -v node)"; NODE="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")"
  printf '{"node":"%s","server":"%s","port":%s}\n' "$NODE" "$DIR/server.js" "$PORT" > "$APP/Contents/Resources/config.json"
fi

cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>shooting-star</string>
<key>CFBundleDisplayName</key><string>shooting-star</string>
<key>CFBundleIdentifier</key><string>dev.shooting-star</string>
<key>CFBundleExecutable</key><string>shooting-star</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${VERSION}</string>
<key>CFBundleVersion</key><string>${VERSION}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>CFBundleURLTypes</key><array><dict>
  <key>CFBundleURLName</key><string>shooting-star</string>
  <key>CFBundleURLSchemes</key><array><string>shooting-star</string></array>
</dict></array>
</dict></plist>
PL
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"
echo "built: $APP ($MODE${UNI:+, universal}, v$VERSION)"
