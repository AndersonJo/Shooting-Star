#!/usr/bin/env bash
# Ubuntu/Debian 용 .deb 빌드:  scripts/make-deb.sh <출력 디렉토리>
# 설치 후: `ss` 명령 + 앱 메뉴 항목. Node.js 18+ 는 apt 의존성(nodejs)으로 설치된다.
set -euo pipefail
OUT="${1:-dist}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/package.json" | head -1)"
ROOT="$(mktemp -d)/pkg"
mkdir -p "$ROOT/DEBIAN" "$ROOT/opt/shooting-star" "$ROOT/usr/bin" "$ROOT/usr/share/applications" "$ROOT/usr/share/icons/hicolor/512x512/apps" "$OUT"
cp -R "$DIR"/*.js "$DIR/package.json" "$DIR/public" "$ROOT/opt/shooting-star/"
cp "$DIR/assets/icon.png" "$ROOT/usr/share/icons/hicolor/512x512/apps/shooting-star.png"
printf '#!/bin/sh\nexec node /opt/shooting-star/server.js "$@"\n' > "$ROOT/usr/bin/ss"; chmod 755 "$ROOT/usr/bin/ss"
cat > "$ROOT/usr/share/applications/shooting-star.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=shooting-star
Comment=Markdown / YAML / CSV / JSON document manager
Exec=/usr/bin/ss --last
Icon=shooting-star
Terminal=false
Categories=Development;Utility;
DESK
cat > "$ROOT/DEBIAN/control" <<CTL
Package: shooting-star
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: all
Depends: nodejs (>= 18)
Maintainer: AndersonJo <noreply@github.com>
Homepage: https://github.com/AndersonJo/Shooting-Star
Description: Lightweight local document manager
 Markdown / YAML / CSV / JSON files in a foldable tree with editor, viewer,
 quick open, full-text search and memos. Runs a local server on 127.0.0.1.
CTL
dpkg-deb --build --root-owner-group "$ROOT" "$OUT/shooting-star_${VERSION}_all.deb" >/dev/null
echo "built: $OUT/shooting-star_${VERSION}_all.deb"
