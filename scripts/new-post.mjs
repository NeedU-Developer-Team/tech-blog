import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const title = process.argv.slice(2).join(' ').trim();

if (!title) {
  console.error('사용법: npm run new -- "글 제목"');
  process.exit(1);
}

const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const slug = title
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 60) || 'new-post';
const postDir = path.join(root, 'content', 'posts');
const postPath = path.join(postDir, `${date}-${slug}.md`);

try {
  await access(postPath);
  console.error(`이미 같은 파일이 있습니다: ${postPath}`);
  process.exit(1);
} catch {
  // 새 파일이므로 계속합니다.
}

const template = `---
title: ${title}
description: 글 목록과 검색 결과에 표시될 한두 문장 요약을 입력하세요.
date: ${date}
author: 작성자 이름
category: Architecture
tags: [Spring, MySQL]
featured: false
---

도입부를 작성하세요. 어떤 문제를 왜 해결했는지 짧게 설명하면 좋습니다.

## 문제 상황

본문을 작성하세요.

## 해결 과정

\`\`\`java
// 코드를 입력하세요.
\`\`\`

## 배운 점

- 핵심 배움 1
- 핵심 배움 2
`;

await mkdir(postDir, { recursive: true });
await writeFile(postPath, template);
console.log(`새 글을 만들었습니다: ${postPath}`);
