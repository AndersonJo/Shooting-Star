#!/usr/bin/env bash
# 새 버전 릴리스 (한 줄):  scripts/release.sh 0.2.0
#  1) package.json 버전 올리고 커밋/태그/푸시 → GitHub Actions 가 zip/deb 빌드 후 Release 생성
#  2) Release 가 끝나면 Homebrew tap(AndersonJo/homebrew-tap)의 cask 버전/sha256 을 갱신해 푸시
# 이후 사용자는 `brew upgrade --cask shooting-star` 로 업데이트한다. (gh 로그인 필요)
set -euo pipefail
V="${1:?usage: scripts/release.sh X.Y.Z}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "버전 형식이 올바르지 않습니다: $V (예: 0.2.0)"; exit 1; }
REPO="AndersonJo/Shooting-Star-"; TAP="AndersonJo/homebrew-tap"
cd "$(dirname "$0")/.."

[ -z "$(git status --porcelain)" ] || { echo "커밋되지 않은 변경이 있습니다. 먼저 커밋하세요."; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo "main 브랜치에서 실행하세요."; exit 1; }
git pull --ff-only -q

sed -i.bak "s/\"version\": *\"[^\"]*\"/\"version\": \"$V\"/" package.json && rm package.json.bak
git commit -qam "Release v$V"
git tag -a "v$V" -m "v$V"
git push -q origin main "v$V"
echo "→ v$V 푸시 완료. GitHub Actions 빌드를 기다립니다…"

RUN=""
for _ in $(seq 1 30); do
  RUN="$(gh run list -R "$REPO" -w release.yml -L 10 --json databaseId,headBranch --jq ".[] | select(.headBranch==\"v$V\") | .databaseId" | head -1)"
  [ -n "$RUN" ] && break; sleep 2
done
[ -n "$RUN" ] || { echo "릴리스 워크플로를 찾지 못했습니다."; exit 1; }
gh run watch "$RUN" -R "$REPO" --exit-status >/dev/null

SHA="$(gh release download "v$V" -R "$REPO" -p "*-macos.zip.sha256" -O - | awk '{print $1}')"
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "sha256 을 읽지 못했습니다: $SHA"; exit 1; }

TMP="$(mktemp -d)"; gh repo clone "$TAP" "$TMP" -- -q
sed -i.bak -e "s/^  version \".*\"/  version \"$V\"/" -e "s/^  sha256 \".*\"/  sha256 \"$SHA\"/" "$TMP/Casks/shooting-star.rb" && rm "$TMP/Casks/shooting-star.rb.bak"
git -C "$TMP" commit -qam "shooting-star $V"
git -C "$TMP" push -q
echo "✓ 릴리스 완료: https://github.com/$REPO/releases/tag/v$V"
echo "  사용자 업데이트: brew upgrade --cask shooting-star"
