# ★ shooting-star

경량 로컬 문서 관리 도구 (markdown / yaml / csv / json). 의존성 없음, Node 18+ 만 필요 (mac / ubuntu).

```bash
./install.sh          # 한 번만: `ss` 명령 설치
ss .                   # IDE의 `code .` 처럼 (네이티브 앱 창으로 열림): 현재 폴더를 워크스페이스로 열기
ss ~/wiki              # 다른 폴더도 동일. 이미 실행 중이면 새 탭으로만 열림

# 설치 없이 직접 실행
node server.js [디렉토리] [--port 4000] [--no-open]
# 예: node server.js ~/wiki
```

- 앱: macOS 는 `install.sh` 가 swiftc 로 네이티브 셸(`macos/ShootingStar.swift`, WKWebView)을 빌드해 `~/Applications/shooting-star.app` 설치 — Dock 에 자체 아이콘, Chrome 불필요 (swiftc 없으면 브라우저 창 방식). Ubuntu 는 앱 메뉴 항목 + Chromium 계열 `--app` 창
- 시작 위치: 마지막으로 연 폴더, 없으면 `~/projects` (설정에서 변경)
- 워크스페이스: 브라우저 탭마다 다른 폴더, ⌘/Ctrl+O 로 앱 안에서 폴더 전환(최근 폴더 포함), 폴더별 탭/펼침 상태 복원
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
