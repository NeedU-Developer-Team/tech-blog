import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const article = await readFile('dist/posts/load-test-performance-improvement/index.html', 'utf8');
const existingArticle = await readFile('dist/posts/우리-팀의-서비스-니쥬를-소개합니다/index.html', 'utf8');
const images = await readdir('dist/assets/images/posts/load-test-improvement');

assert.equal((article.match(/<figure>/g) || []).length, 19);
assert.equal((article.match(/loading="lazy" decoding="async"/g) || []).length, 19);
assert.equal(images.filter((file) => file.endsWith('.png')).length, 19);
assert.match(article, /노주연/);
assert.match(article, /정지호/);
assert.match(existingArticle, /노주연/);

console.log('✓ 복수 작성자, 기존 단일 작성자, 이미지 19개를 확인했습니다.');
