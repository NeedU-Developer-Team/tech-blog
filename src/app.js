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

let toastTimer = 0;
function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.append(toast);
  }
  toast.textContent = message;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function copyWithSelection(text) {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  return copied;
}

document.querySelector('[data-share]')?.addEventListener('click', async () => {
  const link = window.location.href;
  let copied = false;
  try {
    await navigator.clipboard.writeText(link);
    copied = true;
  } catch {
    copied = copyWithSelection(link);
  }
  showToast(copied ? '링크가 복사되었어요' : '링크를 복사하지 못했어요');
});

const tocItems = [...document.querySelectorAll('.toc a')]
  .map((link) => ({ link, section: document.getElementById(decodeURIComponent(link.hash.slice(1))) }))
  .filter((item) => item.section);
if (tocItems.length) {
  let ticking = false;
  const syncToc = () => {
    ticking = false;
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    let current = tocItems[0];
    for (const item of tocItems) {
      if (item.section.getBoundingClientRect().top <= 140) current = item;
      else break;
    }
    if (atBottom) current = tocItems[tocItems.length - 1];
    tocItems.forEach((item) => item.link.classList.toggle('active', item === current));
  };
  syncToc();
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(syncToc); }
  }, { passive: true });
}

const memberFilters = [...document.querySelectorAll('[data-member-filter]')];
const members = [...document.querySelectorAll('[data-member]')];
memberFilters.forEach((button) => button.addEventListener('click', () => {
  const role = button.dataset.memberFilter;
  memberFilters.forEach((item) => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  members.forEach((member) => { member.hidden = role !== '전체' && member.dataset.role !== role; });
}));

const principles = [...document.querySelectorAll('.principles article')];
principles.forEach((card) => ['mouseenter', 'focus'].forEach((type) => card.addEventListener(type, () => {
  principles.forEach((item) => item.classList.toggle('is-active', item === card));
})));

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

if (!reduceMotion && canHover) {
  document.querySelectorAll('[data-tilt]').forEach((element) => {
    const max = Number(element.dataset.tilt) || 8;
    let frame = 0;
    element.addEventListener('pointermove', (event) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        element.classList.add('is-tilting');
        element.style.setProperty('--ry', `${((x - 0.5) * max).toFixed(2)}deg`);
        element.style.setProperty('--rx', `${((0.5 - y) * max).toFixed(2)}deg`);
        element.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
        element.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
      });
    });
    element.addEventListener('pointerleave', () => {
      cancelAnimationFrame(frame);
      element.classList.remove('is-tilting');
      element.style.removeProperty('--rx');
      element.style.removeProperty('--ry');
    });
  });
}

const revealTargets = document.querySelectorAll('[data-reveal]');
if (revealTargets.length && !reduceMotion && 'IntersectionObserver' in window) {
  root.classList.add('motion-ready');
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('in-view');
      revealObserver.unobserve(entry.target);
    });
  }, { threshold: 0.35 });
  revealTargets.forEach((target) => revealObserver.observe(target));
}
