# shooting-star — 개발 메모

## 전제: 하나의 프로젝트가 아니라 수십 개의 git repo 를 동시에 다룬다
- 보통 워크스페이스 루트는 `~/projects` 처럼 **여러 git repo 를 담은 상위 폴더**다 (개인·회사 맥북 모두). 그 안의 각 repo, 그리고 repo 안 어딘가의 `wiki/` 같은 중첩 폴더에 문서가 흩어져 있다.
- 따라서 "워크스페이스 루트 = 프로젝트 루트" 라고 가정하면 안 된다. 문서와 함께 commit/push 되어야 하는 것(첨부 이미지·파일 등)은 **그 문서가 속한 git repo 안**에 둔다 (`.git` 이 있는 가장 가까운 상위 폴더 — submodule·worktree 의 `.git` 파일 포함).
- `~/.shooting-star/…` 같은 공통 위치나 워크스페이스 루트에 repo 문서의 자료를 두지 않는다 (push 하면 링크가 깨진다). 예외: 메모(`~/.shooting-star/memos`)는 repo 에 속하지 않는다.
- repo 마다 자기 `assets/` 같은 폴더가 이미 있을 수 있다 (예: Jekyll 블로그의 `assets/images/`, 앱의 번들 assets). shooting-star 가 만드는 것은 `.ss/` 아래에 둬서 섞이지 않게 한다.

## 첨부 위치
- 새 첨부: `<repo 루트>/.ss/assets/images/YYYYMMDD/`, `<repo 루트>/.ss/assets/files/YYYYMMDD/` (repo 가 아니면 워크스페이스 루트). 문서에는 문서 기준 상대 링크.
- 정리 메뉴(트리 우클릭 → 첨부 정리)는 문서 옆 `images/` 와, 이전 버전이 repo 밖(워크스페이스 루트)에 둔 `assets/(images|files)/YYYYMMDD/` 를 각 문서의 repo 안 `.ss/assets/` 로 옮기고 링크를 고친다.
