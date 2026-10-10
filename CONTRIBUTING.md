# Behind The NeedU 기술 블로그 운영 가이드

이 문서는 NeedU 개발팀원이 기술 블로그에 글을 작성하고 `main`에 바로 배포하는 방법을 설명합니다.

- 저장소: <https://github.com/NeedU-Developer-Team/tech-blog>
- 블로그: <https://needu-developer-team.github.io/tech-blog/>
- 배포 방식: `main` 브랜치에 반영되면 GitHub Actions가 자동 배포

## 가장 짧은 발행 순서

```bash
git switch main
git pull origin main
npm run new -- "글 제목"
```

생성된 Markdown 파일을 작성한 다음:

```bash
npm run build
git add content/posts
git commit -m "docs: 글 제목"
git push origin main
```

`main`에 push하면 GitHub Actions가 자동으로 배포합니다.

## 1. 처음 한 번만 준비하기

### 필요한 프로그램

- Git
- Node.js 20 이상
- Python 3: 로컬 미리보기 서버에 사용
- GitHub CLI(`gh`): 선택 사항

버전을 확인합니다.

```bash
git --version
node --version
python3 --version
```

Node.js 버전은 `v20` 이상이어야 합니다. 이 프로젝트는 외부 npm 패키지를 사용하지 않으므로 `npm install`은 필요하지 않습니다.

### 저장소 받기

```bash
git clone https://github.com/NeedU-Developer-Team/tech-blog.git
cd tech-blog
```

GitHub 조직 초대를 먼저 수락해야 저장소에 push할 수 있습니다.

## 2. 새 글 작성하기

항상 글을 작성하기 전에 `main`을 최신 상태로 맞춥니다.

```bash
git switch main
git pull origin main
```

새 글 파일을 생성합니다.

```bash
npm run new -- "Redis 분산 락을 운영하며 배운 것"
```

`content/posts` 아래에 날짜가 포함된 Markdown 파일이 만들어집니다.

```text
content/posts/2026-10-03-redis-분산-락을-운영하며-배운-것.md
```

## 3. 글 정보 작성하기

파일 위쪽의 `---` 사이 영역을 front matter라고 합니다.

```yaml
---
title: Redis 분산 락을 운영하며 배운 것
description: 동시성 문제를 해결하며 분산 락의 만료 시간과 재시도 정책을 정한 과정을 공유합니다.
date: 2026-10-03
author: 노주연
category: Architecture
tags: [Redis, Concurrency, Spring]
featured: false
---
```

각 항목의 의미는 다음과 같습니다.

| 항목 | 작성 방법 |
| --- | --- |
| `title` | 글 제목 |
| `description` | 목록과 검색 결과에 표시할 한두 문장 요약 |
| `date` | `YYYY-MM-DD` 형식의 발행일 |
| `author` | 한 명이면 `노주연`, 여러 명이면 `[노주연, 정지호]`처럼 `content/team.json`의 `name`과 정확히 같은 이름을 작성 |
| `category` | 글의 대표 주제 하나 |
| `tags` | 세부 기술 키워드, 보통 2~4개 |
| `featured` | 메인 상단에 강조할 글만 `true` |

값은 따옴표로 감싸지 않습니다. `title: "글 제목"`처럼 쓰면 따옴표까지 제목에 그대로 표시됩니다.

`author`는 메인 카드와 글 상단의 작성자 표시, 그리고 팀 페이지의 팀원별 작성 글 목록에 사용됩니다. 이름이 `team.json`과 한 글자라도 다르면 GitHub 링크가 붙지 않고, 팀 페이지에서 해당 팀원의 글로 집계되지 않습니다.

`description`은 메인 상단 대표 카드에서 두 줄까지만 보이고, 제목은 세 줄까지만 보입니다. 넘치는 부분은 말줄임표로 처리되므로 요약의 앞부분에 핵심을 씁니다.

카테고리는 가능하면 아래 이름을 재사용합니다. 새 카테고리를 쓰면 메인의 카테고리 필터 버튼이 자동으로 하나 늘어나므로, 표기를 통일해야 필터가 불필요하게 늘어나지 않습니다.

- `Architecture`
- `Database`
- `Performance`
- `Reliability`
- `Frontend`
- `Backend`
- `AI`
- `Service`
- `DevOps`
- `Team`

`featured: true`인 글은 한 편만 유지하는 것을 권장합니다. 새로운 대표 글을 지정할 때는 기존 대표 글을 `false`로 변경합니다. `featured: true`인 글이 없으면 가장 최근 글이 대표 카드에 표시됩니다.

## 4. 본문 작성 규칙

글 제목은 페이지에서 자동으로 생성되므로 본문에 `# 제목`을 다시 쓰지 않습니다.

````markdown
문제를 한두 문단으로 소개합니다.

## 문제 상황

문제가 발생한 배경과 영향을 설명합니다.

## 해결 과정

선택지를 비교하고 최종 결정을 내린 근거를 설명합니다.

### 세부 구현

```java
public void example() {
    // 공개 가능한 예시 코드
}
```

> 핵심적인 판단이나 배운 점은 인용문으로 강조할 수 있습니다.

## 결과와 배운 점

- 측정 결과
- 아쉬웠던 점
- 다음 개선 계획
````

지원하는 Markdown 요소:

- `##`, `###` 제목
- 순서 있는 목록과 순서 없는 목록
- 코드 블록
- 표
- 인용문
- 링크
- 이미지와 이미지 설명
- 굵은 글씨와 인라인 코드
- 이미지 (한 줄에 이미지 하나)

코드 블록에 언어를 적으면 문법에 따라 색이 입혀집니다. 지원하는 언어는 `java`, `python`(`py`), `sql`, `json`, `http`입니다. 그 밖의 언어나 언어를 적지 않은 블록은 색 없이 표시됩니다. 실행 결과, 로그, `EXPLAIN` 출력처럼 코드가 아닌 내용은 `text`로 적어야 엉뚱한 단어에 색이 입혀지지 않습니다.

````markdown
```python
def example():
    return "언어를 적으면 색이 입혀집니다"
```
````

이미지는 `content/images/<글 파일 이름>/` 폴더에 넣고 `/images/...` 경로로 참조합니다. 따옴표 안의 값은 이미지 아래 캡션으로 표시되며 생략할 수 있습니다.

```markdown
![대체 텍스트](/images/2026-10-05-ai-chatbot-csrf-authentication/user-report.png "이미지 아래에 표시할 캡션")
```

스크린샷에 사용자 이름, 프로필 사진, 연락처 등 개인정보가 보이면 반드시 가린 뒤 올립니다.

글에 넣을 이미지는 `src/images/posts/글-식별자` 아래에 저장하고 다음처럼 작성합니다. `/assets`로 시작해야 GitHub Pages의 저장소 하위 경로에서도 정상적으로 표시됩니다.

```markdown
![부하 테스트 전후 처리량 비교](/assets/images/posts/load-test-improvement/throughput.png)
```

이미지 설명은 접근성을 위한 대체 텍스트이자 화면에 표시되는 캡션이므로 `image.png` 대신 내용을 설명하는 문장을 사용합니다.

좋은 글은 보통 `문제 → 검토한 선택지 → 결정과 근거 → 결과 → 배운 점`의 흐름을 가집니다.

## 5. 로컬에서 확인하기

작성 중 자동 빌드를 실행합니다.

```bash
npm run dev
```

다른 터미널을 열어 미리보기 서버를 실행합니다.

```bash
cd tech-blog
npm run serve
```

브라우저에서 <http://localhost:4173>을 엽니다.

`Address already in use` 오류가 나오면 다른 포트를 사용합니다.

```bash
python3 -m http.server 4174 --directory dist
```

이 경우 <http://localhost:4174>로 접속합니다.

자동 빌드가 필요 없다면 아래처럼 한 번만 빌드해도 됩니다.

```bash
npm run build
npm run serve
```

## 6. 글을 올리기 전 확인사항

### 내용 확인

- 제목과 요약만 읽어도 글의 주제와 결론을 알 수 있는가?
- 기술을 선택한 이유와 비교 대상이 설명되어 있는가?
- 숫자와 성능 결과에 측정 조건이 포함되어 있는가?
- 다른 팀원이 이해하기 어려운 내부 용어가 설명되어 있는가?
- 모바일에서 코드와 표가 읽기 쉬운가?

### 보안 확인

아래 내용은 절대 공개 저장소에 올리지 않습니다.

- 비밀번호, API 키, 액세스 토큰, 쿠키
- 운영 DB 주소와 계정 정보
- 비공개 내부 도메인, 서버 IP, 상세 인프라 구성
- 실제 사용자 이름, 이메일, 전화번호 등 개인정보
- 운영 데이터 원본과 민감한 로그
- 외부 공개가 허용되지 않은 회사·프로젝트 자료

필요하면 값과 이름을 가상의 예시로 바꿉니다.

### 빌드 확인

```bash
npm run build
git diff --check
git status --short
```

`npm run build`가 성공해야 `main`에 push합니다.

## 7. GitHub `main`에 바로 올리기

변경된 파일을 확인합니다.

```bash
git status --short
git diff
```

작성한 글을 commit합니다.

```bash
git add content/posts src/images/posts
git commit -m "docs: Redis 분산 락 운영 경험 추가"
git push origin main
```

push하기 전에 다른 팀원이 먼저 변경 사항을 올렸다면 push가 거절될 수 있습니다. 이때는 강제로 push하지 말고 최신 변경을 받아옵니다.

```bash
git pull --rebase origin main
git push origin main
```

충돌이 발생하면 충돌난 파일을 직접 정리한 다음 계속합니다.

```bash
git add 충돌을-해결한-파일
git rebase --continue
git push origin main
```

`git push --force` 또는 `git push -f`는 사용하지 않습니다. 글 검토가 필요한 경우에는 push 전에 작성 중인 파일을 팀원에게 공유합니다.

## 8. 배포 확인하기

변경 사항을 `main`에 push하면 `.github/workflows/pages.yml`이 자동으로 실행됩니다.

1. 저장소의 `Actions` 탭을 엽니다.
2. `Deploy BEHIND to GitHub Pages` 작업을 확인합니다.
3. `build`와 `deploy`가 모두 초록색이면 배포 성공입니다.
4. 블로그에서 새 글을 확인합니다.

배포 반영에는 보통 몇 분 정도 걸릴 수 있습니다. Actions가 성공했는데 이전 화면이 보이면 잠시 기다린 뒤 강력 새로고침합니다.

## 9. 기존 글 수정하기

기존 글도 최신 `main`을 받은 뒤 수정하고 바로 push합니다.

```bash
git switch main
git pull origin main

# content/posts의 기존 글 수정

npm run build
git add content/posts
git commit -m "docs: 기존 글 내용 보완"
git push origin main
```

이미 공개된 글의 의미를 크게 바꾸는 경우에는 기존 내용을 조용히 삭제하기보다 변경 이유를 글에 남깁니다.

## 10. 팀원 정보 변경하기

팀원 정보는 `content/team.json`에 있습니다.

```json
{
  "name": "이름",
  "role": "Frontend Engineer",
  "focus": "관심 기술 · 담당 영역",
  "initial": "성",
  "color": "blue",
  "github": "https://github.com/GitHub-ID"
}
```

사용 가능한 색상은 `blue`, `cyan`, `violet`, `green`입니다. JSON에서는 마지막 항목 뒤에 쉼표를 붙이지 않습니다.

`role`은 `Frontend Engineer`, `Backend Engineer`, `DevOps Engineer`, `AI Engineer`처럼 `<직군> Engineer` 형식으로 입력합니다. 팀 페이지의 직군 필터는 이 값에서 ` Engineer`를 뺀 이름으로 자동 생성되므로, 같은 직군은 대소문자까지 똑같이 적습니다.

`name`은 글 front matter의 `author`와 정확히 같아야 합니다. 팀 페이지에서 팀원 카드를 펼치면 `author`가 일치하는 글만 작성 글 목록에 표시됩니다.

블로그 이름(`name`), 설명(`description`), 메인 상단 라벨(`teamLabel`), 팀 GitHub 주소(`github`)는 `site.config.json`에서 관리합니다.

## 11. 수정하면 안 되는 파일

`dist`는 빌드할 때 자동 생성되는 결과물입니다. 직접 수정해도 다음 빌드 때 사라지므로 수정하지 않습니다.

일반적인 수정 위치:

```text
content/posts/       기술 아티클
content/team.json    팀원 정보
site.config.json     블로그 기본 정보
src/                 디자인과 화면 동작
scripts/             빌드 로직
```

## 12. 자주 발생하는 문제

### `Could not read package.json`

프로젝트가 아닌 상위 폴더에서 명령을 실행한 경우입니다.

```bash
cd ~/project/tech-blog
```

### `Address already in use`

4173 포트를 다른 프로그램이 사용 중입니다.

```bash
python3 -m http.server 4174 --directory dist
```

### 글이 목록에 나타나지 않음

- 글이 `content/posts`에 있는지 확인합니다.
- 파일 확장자가 `.md`인지 확인합니다.
- 파일 위아래의 `---`가 빠지지 않았는지 확인합니다.
- `date`가 `YYYY-MM-DD` 형식인지 확인합니다.
- `npm run build`를 다시 실행합니다.

### 팀 페이지에 내 글이 보이지 않음

- 글의 `author`가 `content/team.json`의 `name`과 띄어쓰기까지 같은지 확인합니다.
- `author`를 따옴표로 감싸지 않았는지 확인합니다.

### GitHub Actions 배포 실패

- 로컬에서 `npm run build`가 성공하는지 확인합니다.
- Actions 실패 화면에서 `Build` 단계의 오류를 확인합니다.
- `main` 브랜치에 변경 사항이 반영됐는지 확인합니다.
- 저장소 `Settings → Pages`의 Source가 `GitHub Actions`인지 확인합니다.

## 운영 원칙

1. 결과만 나열하지 않고 의사결정의 근거를 남깁니다.
2. 실패와 시행착오도 재현 가능한 배움으로 정리합니다.
3. 개인이나 팀을 비난하지 않고 시스템과 개선에 집중합니다.
4. 운영 정보와 개인정보를 공개하지 않습니다.
5. 작업 전에는 반드시 `git pull origin main`으로 다른 팀원의 변경을 먼저 받습니다.
