# ★ shooting-star

경량 로컬 문서 관리 도구 (markdown / yaml / csv / json).

## 설치

| | 설치 | 업데이트 |
|---|---|---|
| **macOS (Homebrew)** | `brew install --cask AndersonJo/tap/shooting-star` | `brew upgrade --cask shooting-star` |
| **macOS (수동)** | [Releases](https://github.com/AndersonJo/Shooting-Star/releases) 의 `shooting-star-*-macos.zip` → 압축 해제 후 `/Applications` 로 이동 | 새 zip 으로 교체 |
| **Ubuntu / Debian** | Releases 의 `.deb` 더블클릭, 또는 `sudo apt install ./shooting-star_*_all.deb` | 새 `.deb` 설치 |
| **개발 (소스)** | `git clone … && ./install.sh` | `git pull && ./install.sh` |

- Node.js 18+ 필요 (Homebrew / apt 가 자동 설치). 설치 후 Spotlight/Raycast 에서 `shooting-star`, 터미널에서 `ss .`
- 수동 설치한 mac 앱을 처음 열 때 "확인되지 않은 개발자" 경고가 뜨면 우클릭 → 열기 (또는 `xattr -dr com.apple.quarantine /Applications/shooting-star.app`)
- 새 버전이 나오면 앱 상태바에 `⬆ vX.Y.Z` 로 알려 줍니다 (설정에서 끌 수 있음)

## 문제 해결
- 앱을 열었는데 `not found` 등 이상한 화면이 보이면: 터미널에서 `ss --status` (서버 상태/최근 로그). 기본 포트 4000 을 다른 프로그램이 쓰고 있으면 자동으로 4001, 4002 … 를 사용하고 `~/.shooting-star/server.json` 에 기록합니다.
- 이미지가 `이미지를 열 수 없습니다` 로 나오거나 새 기능이 안 보이면: 이전 코드의 서버가 떠 있는 경우입니다. `git pull` 후에는 이제 `ss`/앱이 코드 변경을 감지해 서버를 자동으로 재시작합니다 (수동: `ss --stop`).
- `not found` 만 보이면: 예전 버전/삭제된 폴더의 서버 프로세스가 남아 있던 경우입니다. 이제는 다른 위치/버전의 서버를 자동으로 재시작합니다. 수동으로는 `ss --stop` 후 다시 여세요.
- 진단: `ss --doctor` (버전, node, 설치 위치, 포트 4000~4005 점유 현황, 최근 로그 — 문제 신고 시 붙여 주세요), 상태: `ss --status`
- 서버 로그: `~/.shooting-star/server.log`, 서버 종료: `ss --stop`

## 사용

```bash
./install.sh          # 한 번만: `ss` 명령 설치
ss .                   # IDE의 `code .` 처럼 (네이티브 앱 창으로 열림): 현재 폴더를 워크스페이스로 열기
ss ~/wiki              # 다른 폴더도 동일. 이미 실행 중이면 새 탭으로만 열림

# 설치 없이 직접 실행
node server.js [디렉토리] [--port 4000] [--no-open]
# 예: node server.js ~/wiki
```

- 테마: 설정(⚙ / ⌘,)에서 선택 — 시스템 설정 따르기, 다크, 라이트, 미드나잇, Nord, Solarized Dark, Dracula. 네이티브 앱은 창 밝기/배경도 함께 변경
- 앱: macOS 는 `install.sh` 가 swiftc 로 네이티브 셸(`macos/ShootingStar.swift`, WKWebView)을 빌드해 `~/Applications/shooting-star.app` 설치 — Dock 에 자체 아이콘, Chrome 불필요 (swiftc 없으면 브라우저 창 방식). Ubuntu 는 앱 메뉴 항목 + Chromium 계열 `--app` 창
- 시작 위치: 마지막으로 연 폴더, 없으면 `~/projects` (설정에서 변경)
- 워크스페이스: 브라우저 탭마다 다른 폴더, ⌘/Ctrl+O 로 앱 안에서 폴더 전환(최근 폴더 포함), 폴더별 탭/펼침 상태 복원
- 이미지 뷰어: 이미지를 누르면 화면에 맞춰 표시 (png/jpg/gif/webp/avif/svg/bmp/heic/tiff). ←/→ 로 같은 폴더의 이전/다음 이미지 (앞뒤를 미리 디코딩해 깜빡임 없음), 휠/핀치·+/− 확대, 더블클릭 맞춤↔원본, `0` 맞춤, `1` 100%, `F` 전체화면. 큰 사진은 서버가 화면 크기로 줄인 이미지(`~/.shooting-star/cache`)를 먼저 보여 주고 확대할 때만 원본으로 교체
- 문서 안 검색: ⌘/Ctrl+F (편집기·마크다운·CSV 모두, 모든 일치 표시, Enter/Shift+Enter 이동, 대소문자·단어·정규식)
- 외부 변경 실시간 반영: 다른 에디터/터미널/git 이 파일을 바꾸면 트리와 열린 탭이 자동 갱신 (저장 안 한 편집이 있으면 ⚠ 충돌 표시 후 저장 시 덮어쓰기 확인)
- 우클릭: Finder(파일 관리자)에서 열기/보기, 터미널에서 열기(mac), 기본 앱으로 열기
- 트리에서 파일/폴더를 선택하고 ⌘/Ctrl+C → 전체 경로 복사 (Shift 를 같이 누르면 상대 경로)
- 좌측 트리(접기/펼치기, 우클릭: 새 파일/폴더·이름변경·삭제·경로복사), ⌘/Ctrl+P 빠른 열기
- 검색: Shift×2 / ⌘P 파일 이름 검색(백그라운드 인덱싱), ⌘/Ctrl+Shift+F 전체 파일 내용 검색(대소문자·단어·정규식·파일 마스크, 미리보기, 해당 줄로 이동). ripgrep 이 있으면 자동 사용
- 트리 필터(깔때기 버튼): 설정된 검색 대상 형식(기본 YAML·JSON·Python·Markdown·Java)이 있는 폴더만 표시
- 메모: 맨 왼쪽 아이콘 바(파일/메모). `~/.shooting-star/memos/*.md` 에 평범한 마크다운으로 저장, 입력을 멈추면 자동 저장, 검색, ⌘/Ctrl+Alt+N 로 새 메모
- 탭, 저장(⌘S), 외부 변경 감지, 열린 탭/펼침 상태 복원
- Markdown: 보기/분할/편집, 코드블록 복사, 상대 링크·이미지
- JSON/YAML: 실시간 검증, 트리 뷰(키=경로 복사, 값=값 복사), Prettify(⌘/Ctrl+Alt+L), Minify
- CSV/TSV: 테이블 뷰(셀 클릭 복사), 구분자 자동 감지
- 127.0.0.1 에만 바인딩, 루트 밖 접근 차단

## Third-party (public/vendor)
[marked](https://github.com/markedjs/marked) (MIT), [DOMPurify](https://github.com/cure53/DOMPurify) (Apache-2.0 / MPL-2.0), [js-yaml](https://github.com/nodeca/js-yaml) (MIT) — 오프라인 동작을 위해 번들. 앱 아이콘은 `assets/icon.png`.

## 릴리스 (관리자용)
```bash
scripts/release.sh 0.2.0   # 버전 올림 → 커밋/태그/푸시 → Actions 가 zip·deb 빌드 → Homebrew tap 갱신
```
태그(`v*`)를 푸시하면 `.github/workflows/release.yml` 이 macOS universal 앱(zip)과 Ubuntu `.deb` 를 빌드해 GitHub Release 에 올립니다.
사용자는 `brew upgrade --cask shooting-star` 로 업데이트하고, 앱은 새 버전이 있으면 상태바에 알려 줍니다.
