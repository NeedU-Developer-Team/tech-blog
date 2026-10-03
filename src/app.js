const root = document.documentElement;
const themeButton = document.querySelector('.theme-toggle');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const savedTheme = localStorage.getItem('behind-theme');

function applyTheme(theme) {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  themeButton?.setAttribute('aria-label', theme === 'dark' ? '라이트 모드로 변경' : '다크 모드로 변경');
}

applyTheme(savedTheme || (systemDark.matches ? 'dark' : 'light'));
themeButton?.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('behind-theme', next);
});

const header = document.querySelector('.site-header');
const syncHeader = () => header?.classList.toggle('scrolled', window.scrollY > 8);
syncHeader();
window.addEventListener('scroll', syncHeader, { passive: true });

const menuButton = document.querySelector('.menu-toggle');
const mobileNav = document.querySelector('.mobile-nav');
menuButton?.addEventListener('click', () => {
  const open = mobileNav?.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(Boolean(open)));
  menuButton.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
});
mobileNav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  mobileNav.classList.remove('open');
  menuButton?.setAttribute('aria-expanded', 'false');
}));

const filterButtons = [...document.querySelectorAll('[data-filter]')];
const searchInput = document.querySelector('[data-search-input]');
const articles = [...document.querySelectorAll('[data-article]')];
const emptyState = document.querySelector('[data-empty]');
let currentFilter = '전체';

function filterArticles() {
  const query = searchInput?.value.trim().toLowerCase() || '';
  let visible = 0;
  articles.forEach((article) => {
    const categoryMatch = currentFilter === '전체' || article.dataset.category === currentFilter;
    const queryMatch = !query || article.dataset.search.includes(query);
    const show = categoryMatch && queryMatch;
    article.hidden = !show;
    if (show) visible += 1;
  });
  if (emptyState) emptyState.hidden = visible !== 0;
}

filterButtons.forEach((button) => button.addEventListener('click', () => {
  currentFilter = button.dataset.filter;
  filterButtons.forEach((item) => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  filterArticles();
}));
searchInput?.addEventListener('input', filterArticles);

document.querySelectorAll('.copy-button').forEach((button) => button.addEventListener('click', async () => {
  const code = button.closest('.code-block')?.querySelector('code')?.textContent || '';
  await navigator.clipboard.writeText(code);
  button.textContent = '복사됨';
  setTimeout(() => { button.textContent = '복사'; }, 1400);
}));

document.querySelector('[data-share]')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (navigator.share) {
    await navigator.share({ title: button.dataset.title, url: window.location.href });
  } else {
    await navigator.clipboard.writeText(window.location.href);
    button.textContent = '복사됐어요';
    setTimeout(() => { button.textContent = '링크 복사'; }, 1600);
  }
});

const tocLinks = [...document.querySelectorAll('.toc a')];
if (tocLinks.length) {
  const sections = tocLinks.map((link) => document.querySelector(link.getAttribute('href'))).filter(Boolean);
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      tocLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`));
    });
  }, { rootMargin: '-20% 0px -70% 0px' });
  sections.forEach((section) => observer.observe(section));
}
