# BEHIND — 백엔드 팀 기술 블로그

토스처럼 빠르고 담백한 인상을 참고해 만든 정적 기술 블로그입니다. 글은 Markdown으로 작성하며, `main` 브랜치에 올리면 GitHub Pages가 자동으로 빌드하고 배포합니다. 별도 서버나 데이터베이스가 필요 없습니다.

## 0. 먼저 바꿀 것

1. `site.config.json`에서 팀 이름, 소개, GitHub 주소를 바꿉니다.
2. `content/team.json`에서 팀원 이름, 관심 분야, GitHub 주소를 바꿉니다.
3. `content/posts`의 샘플 글을 수정하거나 삭제합니다.

## 1. 내 컴퓨터에서 확인하기

Node.js 20 이상이 필요합니다. 외부 패키지는 설치하지 않습니다.

```bash
npm run build
npm run serve
```

브라우저에서 `http://localhost:4173`을 엽니다. 소스가 바뀔 때마다 자동으로 다시 만들려면 다른 터미널에서 아래 명령을 실행합니다.

```bash
npm run dev
```

## 2. 새 글 쓰기

```bash
npm run new -- "Redis 분산 락을 운영하며 배운 것"
```

`content/posts`에 오늘 날짜가 붙은 Markdown 파일이 생깁니다. 파일 상단의 정보를 채우고 본문을 작성합니다.

```yaml
---
title: 글 제목
description: 목록에 표시할 한두 문장 요약
date: 2026-10-02
author: 작성자 이름
category: Architecture
tags: [Spring, Redis]
featured: false
---
```

- `featured: true`인 최신 글 하나가 메인 화면의 큰 카드에 표시됩니다.
- `category`는 메인 화면 필터가 됩니다.
- `tags`는 검색 대상과 글 하단 태그가 됩니다.
- 제목은 `##`, 소제목은 `###`를 사용합니다.
- 코드 블록, 표, 인용문, 순서 목록, 링크를 지원합니다.

작성 후 반드시 확인합니다.

```bash
npm run build
```

## 3. GitHub에 처음 올리기

### GitHub 웹에서 빈 저장소 만들기

1. GitHub 오른쪽 위 `+` → `New repository`를 누릅니다.
2. 저장소 이름을 정합니다. 예: `backend-tech-blog`.
3. 공개 블로그라면 `Public`을 선택합니다.
4. `README`, `.gitignore`, 라이선스 자동 생성은 체크하지 않고 저장소를 만듭니다.

### 이 폴더를 저장소에 연결하기

아래의 `YOUR-ORG`와 저장소 이름을 실제 값으로 바꿉니다.

```bash
git init
git add .
git commit -m "feat: launch backend tech blog"
git branch -M main
git remote add origin https://github.com/YOUR-ORG/backend-tech-blog.git
git push -u origin main
```

### GitHub Pages 켜기

1. 저장소에서 `Settings` → 왼쪽 `Pages`로 이동합니다.
2. `Build and deployment`의 `Source`를 `GitHub Actions`로 선택합니다.
3. `Actions` 탭에서 `Deploy BEHIND to GitHub Pages` 작업이 성공할 때까지 기다립니다.
4. 완료된 작업의 `deploy` 단계에 표시된 주소를 엽니다.

프로젝트 저장소라면 주소는 보통 `https://YOUR-ID.github.io/backend-tech-blog/`입니다. 이 블로그는 저장소 하위 경로를 자동으로 인식하므로 링크와 스타일이 깨지지 않습니다.

## 4. 이후 글을 발행하는 흐름

팀원은 저장소를 한 번 받은 뒤 매번 아래 흐름만 반복하면 됩니다.

```bash
git pull
npm run new -- "글 제목"
# Markdown 작성
npm run build
git switch -c post/my-new-article
git add content/posts
git commit -m "docs: add my new article"
git push -u origin post/my-new-article
```

GitHub에서 Pull Request를 만들고 팀 리뷰를 받은 뒤 `main`에 병합합니다. 병합되면 GitHub Actions가 자동 배포합니다.

권장 리뷰 기준:

- 개인 정보, 토큰, 내부 도메인, 고객 데이터가 포함되지 않았는가
- 수치와 장애 원인이 외부 공개 가능한가
- 코드가 실제 서비스 비밀을 노출하지 않는가
- 제목과 요약만 읽어도 글의 문제와 결론이 드러나는가
- 모바일에서 표와 코드가 읽히는가

## 5. 커스텀 도메인 연결하기

예: `tech.example.com`

1. 저장소 `Settings` → `Pages` → `Custom domain`에 도메인을 입력하고 저장합니다.
2. 도메인 관리 화면에서 `tech`의 `CNAME`을 `YOUR-ID.github.io`로 설정합니다. 저장소 이름은 붙이지 않습니다.
3. DNS 반영 후 GitHub Pages에서 `Enforce HTTPS`를 켭니다.
4. GitHub 계정/조직의 `Settings` → `Pages`에서 도메인을 먼저 검증하면 탈취 위험을 줄일 수 있습니다.

DNS 반영에는 시간이 걸릴 수 있습니다. 와일드카드 DNS(`*.example.com`)는 사용하지 않는 편이 안전합니다.

## 6. 팀 운영 추천

- 글 상태를 Issue의 `idea → draft → review → published` 라벨로 관리합니다.
- 한 달에 한 번 오래된 글의 링크와 버전을 점검합니다.
- 장애 글은 사람보다 시스템과 재발 방지에 초점을 둡니다.
- `CODEOWNERS`로 BE 리뷰어 한 명 이상을 필수로 지정합니다.
- 공개 전 보안 검토가 필요한 주제는 PR 템플릿 체크리스트에 넣습니다.

## 구조

```text
content/posts/       Markdown 글
content/team.json    팀원 정보
src/                 스타일, 동작, 파비콘
scripts/             빌드 및 새 글 생성기
.github/workflows/   GitHub Pages 자동 배포
site.config.json     블로그 기본 정보
dist/                빌드 결과(자동 생성)
```

## 문제 해결

- Actions가 실행되지 않으면 기본 브랜치가 `main`인지 확인합니다.
- Pages 메뉴에서 Source가 `GitHub Actions`인지 확인합니다.
- 글이 보이지 않으면 front matter의 `---` 두 줄과 날짜 형식을 확인합니다.
- 로컬 주소가 이미 사용 중이면 `python3 -m http.server 4174 --directory dist`처럼 포트를 바꿉니다.
- 배포는 성공했는데 옛 화면이 보이면 강력 새로고침하거나 1–2분 뒤 다시 확인합니다.

## 라이선스

팀 상황에 맞는 라이선스를 선택하세요. 사내 코드나 글의 공개 정책이 있다면 그 정책을 우선합니다.
