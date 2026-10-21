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
- 업데이트 버튼: 설정(⚙) → 버전/업데이트 → `지금 업데이트` (상태바 `⬆` 칩을 눌러도 됩니다). 설치 방식에 맞게 자동으로 처리합니다 — 소스 설치: `git pull --ff-only` (+ 앱 재빌드) 후 서버 재시작 / Homebrew: `brew upgrade --cask` / zip 설치: 릴리스 zip 을 받아 sha256 검증 후 앱 교체 / `.deb`: 설치 명령 안내. 저장하지 않은 탭이 있으면 막습니다
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

- 테마: 설정(⚙ / ⌘,)에서 선택 — 시스템 설정 따르기 / 다크 계열(다크, 미드나잇, Nord, Solarized Dark, Dracula) / 라이트 계열(라이트, Solarized Light, Gruvbox Light, 페이퍼(세피아), Snow, Rosé). 네이티브 앱은 창 밝기/배경도 함께 변경
- 앱: macOS 는 `install.sh` 가 swiftc 로 네이티브 셸(`macos/ShootingStar.swift`, WKWebView)을 빌드해 `~/Applications/shooting-star.app` 설치 — Dock 에 자체 아이콘, Chrome 불필요 (swiftc 없으면 브라우저 창 방식). Ubuntu 는 앱 메뉴 항목 + Chromium 계열 `--app` 창
- 시작 위치: 마지막으로 연 폴더, 없으면 `~/projects` (설정에서 변경)
- 워크스페이스: 브라우저 탭마다 다른 폴더, ⌘/Ctrl+O 로 앱 안에서 폴더 전환(최근 폴더 포함), 폴더별 탭/펼침 상태 복원
- 이미지 뷰어: 이미지를 누르면 화면에 맞춰 표시 (png/jpg/gif/webp/avif/svg/bmp/heic/tiff). ←/→ 로 같은 폴더의 이전/다음 이미지 (앞뒤를 미리 디코딩해 깜빡임 없음), 휠/핀치·+/− 확대, 더블클릭 맞춤↔원본, `0` 맞춤, `1` 100%, `F` 전체화면, ⌘/Ctrl +/−/0 은 이미지 확대/축소/맞춤(텍스트 글자 크기는 안 바뀜). 설정에서 '화면에 꽉 채우기(기본)' / '원본 크기 우선' 선택. 큰 사진은 서버가 화면 크기로 줄인 이미지(`~/.shooting-star/cache`)를 먼저 보여 주고 확대할 때만 원본으로 교체
- 자동 저장: 입력을 멈추고 1초 뒤(설정에서 3초/끄기) 저장하고, 창·탭을 벗어나거나 탭/페이지를 닫을 때도 마지막 편집까지 저장. 외부에서 먼저 수정된 파일은 덮어쓰지 않고 ⚠ 충돌 표시, 문법 오류 중인 JSON/YAML 은 입력 중에는 건너뜀. 메모는 항상 자동 저장
- 스마트 편집(마크다운 4번째 모드): 보기처럼 렌더링된 문서를 블록 단위로 클릭해 그 자리에서 편집. `## ` 를 치면 즉시 제목, Enter 로 문단 나누기/목록 이어쓰기(빈 항목에서 Enter 로 목록 종료), Backspace 로 앞 블록과 합치기, ↑/↓ 로 블록 이동, Esc 로 편집 종료, 체크박스 클릭 토글, 이미지 붙여넣기·끌어놓기, ⌘Z(편집 밖) 문서 단위 되돌리기. 수정한 블록의 원문만 바뀌므로 나머지 마크다운은 그대로 유지(CRLF 포함)
- 마크다운 이미지 첨부: 편집기에 이미지를 붙여넣기(⌘/Ctrl+V, 스크린샷 포함)·끌어놓기하거나 `🖼 이미지` 버튼 → 문서와 같은 폴더의 `images/` 에 저장하고 커서 위치에 `![이름](images/파일)` 삽입 (같은 이미지는 재사용, ⌘Z 로 취소, 메모는 `~/.shooting-star/memos/images/`)
- 문서 안 검색: ⌘/Ctrl+F (편집기·마크다운·CSV 모두, 모든 일치 표시, Enter/Shift+Enter 이동, 대소문자·단어·정규식)
- 외부 변경 실시간 반영: 다른 에디터/터미널/git 이 파일을 바꾸면 트리와 열린 탭이 자동 갱신 (저장 안 한 편집이 있으면 ⚠ 충돌 표시 후 저장 시 덮어쓰기 확인)
- 트리: 폴더는 클릭=펼치고 선택(이미 열려 있으면 선택만), 더블클릭=닫기 (화살표 클릭/Enter 로도 접기·펼치기, ↑↓ 이동, →/← 펼치기·접기), 파일은 클릭=열기
- 하단 상태바에 현재 파일의 전체 경로를 표시: 조각을 클릭하면 왼쪽 트리에서 그 폴더/파일 위치로 이동(폴더를 펼치고 선택, 스크롤), 프로젝트 루트보다 위 폴더를 클릭하면 그 폴더를 워크스페이스로 열기
- 우클릭: Finder(파일 관리자)에서 열기/보기, 터미널에서 열기(mac), 기본 앱으로 열기
- 트리에서 파일/폴더를 선택하고 ⌘/Ctrl+C → 전체 경로 복사 (Shift 를 같이 누르면 상대 경로)
- 좌측 트리(접기/펼치기, 우클릭: 새 파일/폴더·이름변경·삭제·경로복사), ⌘/Ctrl+P 빠른 열기
- Git 보기(왼쪽 아이콘 바): 작업 폴더 안의 모든 git repo 와 **변경된 파일만** 표시 → 파일을 클릭하면 본문 영역에 diff(통합/나란히) 탭으로 표시 · 파일별 체크 · 커밋 메시지 입력 → `커밋` / `커밋 & 푸시`(⌘/Ctrl+Enter). 푸시 안 한 커밋은 `푸시`, 뒤처졌으면 `풀`(fast-forward 만). 처음 푸시하는 브랜치는 `origin` 에 upstream 설정. 인증은 기존 git 설정(ssh 키/credential helper)을 그대로 사용하고 비밀번호 입력창은 뜨지 않음
- 다른 앱에서 파일을 고치고 돌아오면(앱/창 활성화) 트리와 열린 탭을 자동으로 다시 읽음 (저장 안 한 변경이 있으면 충돌 표시)
- 즐겨찾기: 트리에서 폴더 우클릭 → `★ 즐겨찾기에 추가`. 즐겨찾기를 누르면 현재 작업 폴더 안의 폴더는 트리에서 바로 그 폴더로 이동(펼치고 선택), 밖의 폴더는 워크스페이스로 열기
- 트리의 git 변경 표시: 수정(주황 M) · 새 파일(초록 N) · 충돌(빨강 U) 파일은 색과 글자로, 변경이 들어 있는 폴더는 ● 로 표시 (설정에서 끌 수 있음)
- 트리 이름 검색: 트리에서 글자를 치면(한글 포함) 선택한 폴더(파일이면 그 파일이 있는 폴더)의 하위 전체에서 이름이 일치하는 곳을 하이라이트 → `↓`/`↑`(Ctrl+N/P) 다음/이전 일치(접힌 폴더는 자동으로 펼침), `Enter` 열기, `Esc` 취소
- 검색: (파일 이름 검색 목록은 ↑↓ · Ctrl+N/P · PageUp/Down 으로 이동. 검색/경로 입력창은 macOS 자동 수정 말풍선이 방향키를 가로채지 않도록 자동 수정·맞춤법 검사를 끔) Shift×2 / ⌘P 파일 이름 검색(백그라운드 인덱싱), ⌘/Ctrl+Shift+F 전체 파일 내용 검색(대소문자·단어·정규식·파일 마스크, 미리보기, 해당 줄로 이동). ripgrep 이 있으면 자동 사용
- 트리 필터(깔때기 버튼): 설정된 검색 대상 형식(기본 YAML·JSON·Python·Markdown·Java)이 있는 폴더만 표시
- 메모: 맨 왼쪽 아이콘 바(파일/메모). `~/.shooting-star/memos/*.md` 에 평범한 마크다운으로 저장, 입력을 멈추면 자동 저장, 검색, ⌘/Ctrl+Alt+N 로 새 메모
- 탭 우클릭: 닫기 / 다른 탭 모두 닫기 / 오른쪽 탭 모두 닫기 / 모두 닫기 / 경로 복사 / Finder 에서 보기 (가운데 버튼 클릭으로도 닫기). 저장 안 한 탭이 있으면 자동 저장 후 닫고(꺼져 있으면 확인, 취소하면 거기서 중단)
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
