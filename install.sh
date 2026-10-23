#!/usr/bin/env bash
# shooting-star 설치: `ss` 명령 + 앱(macOS: ~/Applications/shooting-star.app, Ubuntu: 앱 메뉴 항목)
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${PREFIX:-$HOME/.local/bin}"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js 18+ 가 필요합니다 (mac: brew install node / ubuntu: sudo apt install nodejs)"; exit 1; }
[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 18 ] || { echo "Node 18 이상이 필요합니다 (현재 $("$NODE" -v))"; exit 1; }
NODE="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")"   # 앱 실행 시엔 PATH 가 없으므로 절대경로 고정

# 1) CLI
mkdir -p "$BIN"
chmod +x "$DIR/server.js"
rm -f "$BIN/ss"   # 구버전이 만든 심볼릭 링크를 따라가 server.js 를 덮어쓰지 않도록
cat > "$BIN/ss" <<EOF
#!/bin/sh
exec "$NODE" "$DIR/server.js" "\$@"
EOF
chmod +x "$BIN/ss"
echo "✓ 명령: $BIN/ss"
# PATH: 로그인 셸 기준으로 rc 파일에 등록 (이미 있으면 건너뜀). 셸은 $SHELL 로 판단 (이 스크립트는 bash 로 돌기 때문)
LINE="export PATH=\"$BIN:\$PATH\"  # shooting-star"
case "$(basename "${SHELL:-}")" in
  zsh)  RCS="$HOME/.zshrc" ;;
  bash) RCS="$HOME/.bashrc"; [ "$(uname)" = Darwin ] && RCS="$RCS $HOME/.bash_profile" ;;
  *)    RCS="$HOME/.profile" ;;
esac
ADDED=""
for RC in $RCS; do
  grep -qsF "# shooting-star" "$RC" && continue
  printf '\n%s\n' "$LINE" >> "$RC"; ADDED="$ADDED $RC"
done
[ -n "$ADDED" ] && echo "✓ PATH 등록:$ADDED"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "! 지금 열려 있는 터미널에는 아직 적용되지 않았습니다. 새 터미널을 열거나 아래를 실행하세요:"
     echo "    export PATH=\"$BIN:\$PATH\"" ;;
esac

# 2) 앱
if [ "$(uname)" = Darwin ]; then
  APP="${APPDIR:-$HOME/Applications}/shooting-star.app"
  if command -v swiftc >/dev/null && "$DIR/scripts/make-app.sh" "$APP" dev >/dev/null 2>&1; then
    # 네이티브 셸 (WKWebView): Dock 에 자체 아이콘/이름으로 표시. Chrome 불필요.
    echo "✓ 앱(네이티브): $APP  (Spotlight / Raycast 에서 'shooting-star' 검색)"
  else
    # swiftc 가 없거나 빌드 실패: Chrome/기본 브라우저 창으로 여는 런처 앱
    rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
    ICONSET="$(mktemp -d)/icon.iconset"; mkdir -p "$ICONSET"
    for s in 16 32 128 256 512; do
      sips -z $s $s "$DIR/assets/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
      sips -z $((s*2)) $((s*2)) "$DIR/assets/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
    done
    iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"
    cat > "$APP/Contents/MacOS/shooting-star" <<EOF
#!/bin/sh
cd "\$HOME"
exec "$NODE" "$DIR/server.js" --last
EOF
    chmod +x "$APP/Contents/MacOS/shooting-star"
    cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>shooting-star</string>
<key>CFBundleDisplayName</key><string>shooting-star</string>
<key>CFBundleIdentifier</key><string>dev.shooting-star</string>
<key>CFBundleExecutable</key><string>shooting-star</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
EOF
    touch "$APP"
    echo "✓ 앱(브라우저 창 방식): $APP — 네이티브 앱은 'xcode-select --install' 후 ./install.sh 를 다시 실행하세요"
  fi
else
  mkdir -p "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps"
  cp "$DIR/assets/icon.png" "$HOME/.local/share/icons/hicolor/512x512/apps/shooting-star.png"
  cat > "$HOME/.local/share/applications/shooting-star.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=shooting-star
Comment=Markdown / YAML / CSV / JSON document manager
Exec=sh -c 'cd "\$HOME" && exec "$NODE" "$DIR/server.js" --last'
Icon=shooting-star
Terminal=false
Categories=Development;Utility;
EOF
  command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  echo "✓ 앱: 앱 메뉴에서 'shooting-star' 검색"
fi
# 3) Claude 연동 (스킬 + SessionStart hook + 권한). 건너뛰려면: SS_NO_AGENT=1 ./install.sh
if [ -z "$SS_NO_AGENT" ]; then
  "$BIN/ss" run install || echo "! Claude 연동 실패 — 나중에 'ss run install' 로 다시 시도하세요"
fi
echo "사용법: ss .  (현재 폴더 열기) · ss --stop (서버 종료)"
