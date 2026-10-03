import { readFile, readdir, rm, mkdir, writeFile, cp, watch } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');
const contentDir = path.join(root, 'content');
const basePath = normalizeBase(process.env.SITE_BASE_PATH || '');
const origin = (process.env.SITE_URL || 'http://localhost:4173').replace(/\/$/, '');

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

function normalizeBase(value) {
  if (!value || value === '/') return '';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

const url = (pathname = '/') => `${basePath}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
const fullUrl = (pathname = '/') => `${origin}${url(pathname)}`;

function parseFrontMatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('Front matter가 없습니다.');
  const data = {};
  for (const line of match[1].split('\n')) {
    const index = line.indexOf(':');
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    }
    data[key] = value;
  }
  return { data, body: match[2].trim() };
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-|-$/g, '');
}

function inlineMarkdown(text) {
  const codes = [];
  let value = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE${codes.length}@@`;
    codes.push(`<code>${code}</code>`);
    return token;
  });
  value = value
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
  codes.forEach((code, index) => { value = value.replace(`@@CODE${index}@@`, code); });
  return value;
}

function markdownToHtml(markdown) {
  const lines = markdown.split('\n');
  const html = [];
  const toc = [];
  let paragraph = [];
  let listType = null;
  let quote = [];
  let inCode = false;
  let codeLanguage = '';
  let code = [];
  let table = null;

  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (listType) html.push(`</${listType}>`);
    listType = null;
  };
  const flushQuote = () => {
    if (quote.length) html.push(`<blockquote>${inlineMarkdown(quote.join(' '))}</blockquote>`);
    quote = [];
  };
  const flushTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    html.push(`<div class="table-wrap"><table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    table = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      flushParagraph(); flushList(); flushQuote(); flushTable();
      if (!inCode) {
        inCode = true;
        codeLanguage = fence[1].trim() || 'text';
        code = [];
      } else {
        const encoded = escapeHtml(code.join('\n'));
        html.push(`<div class="code-block"><div class="code-toolbar"><span>${escapeHtml(codeLanguage)}</span><button class="copy-button" type="button" aria-label="코드 복사">복사</button></div><pre><code>${encoded}</code></pre></div>`);
        inCode = false;
      }
      continue;
    }
    if (inCode) { code.push(line); continue; }

    if (/^\|.+\|$/.test(line.trim())) {
      flushParagraph(); flushList(); flushQuote();
      const cells = line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
      const next = lines[index + 1]?.trim() || '';
      if (!table && /^\|(?:\s*:?-+:?\s*\|)+$/.test(next)) {
        table = [cells];
        index += 1;
      } else if (table) {
        table.push(cells);
      }
      continue;
    } else {
      flushTable();
    }

    const heading = line.match(/^(#{2,3})\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList(); flushQuote();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugify(text);
      toc.push({ level, text, id });
      html.push(`<h${level} id="${id}">${inlineMarkdown(text)}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph(); flushQuote();
      const nextType = unordered ? 'ul' : 'ol';
      if (listType !== nextType) { flushList(); listType = nextType; html.push(`<${listType}>`); }
      html.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }

    const quoteLine = line.match(/^>\s?(.*)$/);
    if (quoteLine) {
      flushParagraph(); flushList();
      quote.push(quoteLine[1]);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushParagraph(); flushList(); flushQuote();
      html.push('<hr>');
      continue;
    }

    if (!line.trim()) {
      flushParagraph(); flushList(); flushQuote();
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph(); flushList(); flushQuote(); flushTable();
  return { html: html.join('\n'), toc };
}

const icon = (name) => {
  const paths = {
    search: '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>',
    sun: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"></path>',
    moon: '<path d="M20.2 15.5A8.4 8.4 0 0 1 8.5 3.8 8.5 8.5 0 1 0 20.2 15.5Z"></path>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"></path>',
    close: '<path d="m6 6 12 12M18 6 6 18"></path>',
    github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7.4A5.8 5.8 0 0 0 19.3 3 5.4 5.4 0 0 0 19.1 0S17.9-.4 15 1.5a13.4 13.4 0 0 0-7 0C5.1-.4 3.9 0 3.9 0A5.4 5.4 0 0 0 3.7 3a5.8 5.8 0 0 0-1.5 4.1c0 5.8 3.5 7 6.8 7.4A4.8 4.8 0 0 0 8 18v4"></path><path d="M8 19c-3 .9-3-1.5-4-2"></path>',
    clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
    external: '<path d="M15 4h5v5M13 11l7-7M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"></path>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"></path>'
  };
  return `<svg class="icon icon-${name}" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
};

function layout({ config, title, description, active = '', content, type = 'website', canonical = '/', scripts = true }) {
  const pageTitle = title === config.name ? title : `${title} · ${config.name}`;
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#ffffff">
  <meta property="og:type" content="${type}">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${fullUrl(canonical)}">
  <link rel="canonical" href="${fullUrl(canonical)}">
  <link rel="icon" href="${url('/assets/favicon.svg')}" type="image/svg+xml">
  <link rel="stylesheet" href="${url('/assets/styles.css')}">
  <title>${escapeHtml(pageTitle)}</title>
</head>
<body>
  <a class="skip-link" href="#main">본문으로 건너뛰기</a>
  <header class="site-header">
    <div class="header-inner container">
      <a class="brand" href="${url('/')}" aria-label="${escapeHtml(config.name)} 홈">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>${escapeHtml(config.name)}</span>
      </a>
      <nav class="desktop-nav" aria-label="주요 메뉴">
        <a ${active === 'posts' ? 'aria-current="page"' : ''} href="${url('/#articles')}">아티클</a>
        <a ${active === 'team' ? 'aria-current="page"' : ''} href="${url('/team/')}">팀</a>
        <a href="${escapeHtml(config.github)}" target="_blank" rel="noreferrer">GitHub ${icon('external')}</a>
      </nav>
      <div class="header-actions">
        <button class="icon-button theme-toggle" type="button" aria-label="테마 변경"><span class="sun-icon">${icon('sun')}</span><span class="moon-icon">${icon('moon')}</span></button>
        <button class="icon-button menu-toggle" type="button" aria-label="메뉴 열기" aria-expanded="false">${icon('menu')}</button>
      </div>
    </div>
    <nav class="mobile-nav" aria-label="모바일 메뉴">
      <a href="${url('/#articles')}">아티클</a>
      <a href="${url('/team/')}">팀</a>
      <a href="${escapeHtml(config.github)}" target="_blank" rel="noreferrer">GitHub</a>
    </nav>
  </header>
  <main id="main">${content}</main>
  <footer class="site-footer">
    <div class="container footer-inner">
      <div><a class="brand footer-brand" href="${url('/')}"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>${escapeHtml(config.name)}</span></a><p>${escapeHtml(config.description)}</p></div>
      <div class="footer-links"><a href="${url('/#articles')}">아티클</a><a href="${url('/team/')}">팀</a><a href="${escapeHtml(config.github)}" target="_blank" rel="noreferrer">GitHub</a></div>
      <p class="copyright">© ${new Date().getFullYear()} ${escapeHtml(config.name)}. Built by the backend team.</p>
    </div>
  </footer>
  ${scripts ? `<script>window.__BASE_PATH__=${JSON.stringify(basePath)};</script><script src="${url('/assets/app.js')}" defer></script>` : ''}
</body>
</html>`;
}

function postCard(post, { featured = false } = {}) {
  const tags = post.tags.slice(0, featured ? 3 : 2).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('');
  return `<article class="post-card ${featured ? 'featured-card' : ''}" data-article data-search="${escapeHtml(`${post.title} ${post.description} ${post.category} ${post.tags.join(' ')} ${post.author}`.toLowerCase())}" data-category="${escapeHtml(post.category)}">
    <a class="post-card-link" href="${url(post.permalink)}" aria-label="${escapeHtml(post.title)} 읽기"></a>
    <div class="card-top"><span class="category-badge">${escapeHtml(post.category)}</span><span class="read-time">${icon('clock')} ${post.readTime}분</span></div>
    <div class="card-body">
      <h${featured ? '2' : '3'}>${escapeHtml(post.title)}</h${featured ? '2' : '3'}>
      <p>${escapeHtml(post.description)}</p>
    </div>
    <div class="card-footer"><div class="tag-list">${tags}</div><div class="post-meta"><span>${escapeHtml(post.author)}</span><time datetime="${post.date}">${formatDate(post.date)}</time></div></div>
  </article>`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' }).format(new Date(`${value}T00:00:00+09:00`));
}

function indexPage(config, posts) {
  const featured = posts.find((post) => post.featured) || posts[0];
  const categories = ['전체', ...new Set(posts.map((post) => post.category))];
  const content = `
  <section class="hero container">
    <div class="hero-copy reveal">
      <span class="eyebrow">${escapeHtml(config.teamLabel)}</span>
      <h1>보이지 않는 곳에서<br><span>더 단단한 서비스</span>를 만듭니다.</h1>
      <p>성공한 결과보다 그 뒤의 선택을 기록합니다.<br class="desktop-only"> 장애, 성능, 아키텍처를 고민한 백엔드 팀의 이야기입니다.</p>
      <a class="text-link" href="#articles">최신 아티클 보기 ${icon('arrow')}</a>
    </div>
    <div class="hero-feature reveal reveal-delay">
      <div class="feature-orbit" aria-hidden="true"><span class="orbit-core">BE</span><i></i><i></i><i></i></div>
      <div class="featured-label"><span>FEATURED</span><time datetime="${featured.date}">${formatDate(featured.date)}</time></div>
      <a href="${url(featured.permalink)}"><h2>${escapeHtml(featured.title)}</h2><p>${escapeHtml(featured.description)}</p><span class="feature-link">읽어보기 ${icon('arrow')}</span></a>
    </div>
  </section>
  <section class="topic-strip" aria-label="다루는 주제"><div class="container topic-inner"><span>우리가 다루는 것</span><div>${['Architecture', 'Database', 'Performance', 'Reliability'].map((item) => `<b>${item}</b>`).join('<i>·</i>')}</div></div></section>
  <section class="articles-section container" id="articles">
    <div class="section-heading"><div><span class="eyebrow">ARTICLES</span><h2>최근에 나눈 이야기</h2></div><p>운영 환경에서 부딪힌 문제와<br>해결 과정을 솔직하게 남깁니다.</p></div>
    <div class="article-controls">
      <div class="filter-list" role="group" aria-label="카테고리 필터">${categories.map((category, index) => `<button class="filter-button${index === 0 ? ' active' : ''}" type="button" data-filter="${escapeHtml(category)}" aria-pressed="${index === 0}">${escapeHtml(category)}</button>`).join('')}</div>
      <label class="search-field">${icon('search')}<span class="sr-only">글 검색</span><input type="search" placeholder="글 검색" data-search-input></label>
    </div>
    <div class="article-grid">${posts.map((post) => postCard(post)).join('')}</div>
    <div class="empty-state" hidden data-empty><span>⌕</span><h3>검색 결과가 없어요</h3><p>다른 키워드나 카테고리로 찾아보세요.</p></div>
  </section>
  <section class="team-callout container">
    <div><span class="eyebrow">OUR TEAM</span><h2>좋은 시스템은<br>좋은 질문에서 시작됩니다.</h2></div>
    <div><p>정답보다 근거를, 개인의 기억보다 팀의 기록을 믿습니다. 우리가 일하고 배우는 방식을 소개합니다.</p><a class="button-primary" href="${url('/team/')}">BE 팀 만나기</a></div>
  </section>`;
  return layout({ config, title: config.name, description: config.description, active: 'posts', canonical: '/', content });
}

function teamPage(config, team) {
  const memberCards = team.map((member) => `<article class="member-card"><div class="avatar avatar-${escapeHtml(member.color)}">${escapeHtml(member.initial)}</div><div><h3>${escapeHtml(member.name)}</h3><p>${escapeHtml(member.role)}</p><span>${escapeHtml(member.focus)}</span></div><a href="${escapeHtml(member.github)}" target="_blank" rel="noreferrer" aria-label="${escapeHtml(member.name)} GitHub">${icon('github')}</a></article>`).join('');
  const content = `
  <section class="team-hero container">
    <span class="eyebrow">BACKEND TEAM</span>
    <h1>함께 고민하고,<br><span>근거를 남기는 팀</span></h1>
    <p>복잡한 문제를 단순하게 풀고, 그 과정에서 얻은 배움을 다음 사람에게 연결합니다.</p>
  </section>
  <section class="principles container">
    <article><span>01</span><h2>고객의 문제부터 봅니다</h2><p>기술의 새로움보다 고객이 겪는 불편과 비즈니스 임팩트를 먼저 확인합니다.</p></article>
    <article><span>02</span><h2>작게 검증하고 확장합니다</h2><p>완벽한 설계를 기다리지 않고, 되돌릴 수 있는 단위로 실험하며 근거를 쌓습니다.</p></article>
    <article><span>03</span><h2>실패도 자산으로 남깁니다</h2><p>장애와 시행착오를 숨기지 않습니다. 재발을 막는 시스템과 문서로 바꿉니다.</p></article>
  </section>
  <section class="members-section container"><div class="section-heading"><div><span class="eyebrow">PEOPLE</span><h2>글을 쓰는 사람들</h2></div><p>서비스의 뒤편을 책임지는<br>백엔드 엔지니어입니다.</p></div><div class="member-grid">${memberCards}</div></section>
  <section class="quote-section"><div class="container"><blockquote>“혼자만 아는 해결책은<br>팀의 해결책이 아닙니다.”</blockquote><p>우리가 기술 블로그를 쓰는 이유</p></div></section>`;
  return layout({ config, title: '팀', description: 'NeedU 백엔드 팀과 우리가 일하는 방식을 소개합니다.', active: 'team', canonical: '/team/', content });
}

function postPage(config, post, previous, next) {
  const toc = post.toc.filter((item) => item.level === 2);
  const adjacent = [previous, next].map((item, index) => item ? `<a class="adjacent-link" href="${url(item.permalink)}"><span>${index === 0 ? '이전 글' : '다음 글'}</span><strong>${escapeHtml(item.title)}</strong></a>` : '<span></span>').join('');
  const content = `
  <article class="article-page">
    <header class="article-header container-narrow">
      <a class="back-link" href="${url('/#articles')}">${icon('arrow')} 모든 글</a>
      <div class="article-kicker"><span class="category-badge">${escapeHtml(post.category)}</span><span>${post.readTime}분 읽기</span></div>
      <h1>${escapeHtml(post.title)}</h1>
      <p class="article-description">${escapeHtml(post.description)}</p>
      <div class="article-author"><div class="mini-avatar">${escapeHtml(post.author.slice(0, 1))}</div><div><strong>${escapeHtml(post.author)}</strong><time datetime="${post.date}">${formatDate(post.date)}</time></div></div>
    </header>
    <div class="article-accent" aria-hidden="true"><span>${escapeHtml(post.category)}</span><div></div></div>
    <div class="article-layout container">
      <aside class="toc"><span>CONTENTS</span><nav>${toc.map((item) => `<a href="#${item.id}">${escapeHtml(item.text)}</a>`).join('')}</nav></aside>
      <div class="prose">${post.html}<div class="article-tags">${post.tags.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join('')}</div><div class="article-share"><p>이 글이 도움이 되었나요?</p><button type="button" class="share-button" data-share data-title="${escapeHtml(post.title)}">링크 복사</button></div></div>
    </div>
    <nav class="adjacent-posts container-narrow" aria-label="이전 및 다음 글">${adjacent}</nav>
  </article>`;
  return layout({ config, title: post.title, description: post.description, type: 'article', canonical: post.permalink, content });
}

async function loadPosts() {
  const files = (await readdir(path.join(contentDir, 'posts'))).filter((file) => file.endsWith('.md'));
  const posts = await Promise.all(files.map(async (file) => {
    const raw = await readFile(path.join(contentDir, 'posts', file), 'utf8');
    const { data, body } = parseFrontMatter(raw);
    const { html, toc } = markdownToHtml(body);
    const slug = file.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    const words = body.replace(/```[\s\S]*?```/g, '').split(/\s+/).filter(Boolean).length;
    return { ...data, body, html, toc, slug, permalink: `/posts/${slug}/`, readTime: Math.max(3, Math.ceil(words / 180)), tags: data.tags || [] };
  }));
  return posts.sort((a, b) => b.date.localeCompare(a.date));
}

async function writePage(relativePath, contents) {
  const filePath = path.join(outDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

async function build() {
  const [config, team, posts] = await Promise.all([
    readFile(path.join(root, 'site.config.json'), 'utf8').then(JSON.parse),
    readFile(path.join(contentDir, 'team.json'), 'utf8').then(JSON.parse),
    loadPosts()
  ]);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, 'assets'), { recursive: true });
  await cp(path.join(root, 'src'), path.join(outDir, 'assets'), { recursive: true });

  await writePage('index.html', indexPage(config, posts));
  await writePage('team/index.html', teamPage(config, team));
  await Promise.all(posts.map((post, index) => writePage(`posts/${post.slug}/index.html`, postPage(config, post, posts[index + 1], posts[index - 1]))));

  const notFound = layout({ config, title: '페이지를 찾을 수 없습니다', description: '요청한 페이지가 존재하지 않습니다.', content: `<section class="not-found container"><span>404</span><h1>길을 잃었어요.</h1><p>요청한 페이지를 찾을 수 없습니다.</p><a class="button-primary" href="${url('/')}">홈으로 돌아가기</a></section>` });
  await writePage('404.html', notFound);

  const sitemap = posts.map((post) => post.permalink).concat(['/', '/team/']).map((item) => `<url><loc>${fullUrl(item)}</loc></url>`).join('');
  await writePage('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemap}</urlset>`);
  await writePage('.nojekyll', '');

  console.log(`✓ ${posts.length}개 글을 ${outDir}에 만들었습니다. (base: ${basePath || '/'})`);
}

await build();

if (process.argv.includes('--watch')) {
  console.log('파일 변경을 기다리는 중입니다…');
  const watcher = watch(root, { recursive: true });
  for await (const event of watcher) {
    if (!event.filename || event.filename.startsWith('dist') || event.filename.startsWith('.git')) continue;
    try { await build(); } catch (error) { console.error(error); }
  }
}
