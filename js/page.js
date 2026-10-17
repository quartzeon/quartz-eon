/* Quartz Eon info pages (about, FAQ, terms, privacy, 404): the same header as the shop, with the dark mode
   button and the saved products count. No Supabase here. */
(function () {
  'use strict';

  const root = document.documentElement;
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const byId = (id) => document.getElementById(id);
  /* 404.html has <base href="/quartz-eon/">, which would send "#i-sun" and "#top" to the shop address, so icon links
     point at this page in full there. */
  const here = document.querySelector('base') ? window.location.href.split('#')[0] : '';
  const icon = (id) => `<svg class="i" aria-hidden="true" focusable="false"><use href="${here}#${id}"/></svg>`;
  if (here) document.querySelectorAll('use[href^="#"]').forEach((use) => use.setAttribute('href', here + use.getAttribute('href')));
  const storage = {
    get(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }
  };

  /* ---------- Theme (same as the shop: an explicit choice is stamped on <html data-theme>) ---------- */
  const themeButton = byId('theme-toggle');

  function currentTheme() {
    const attr = root.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    return darkQuery.matches ? 'dark' : 'light';
  }

  function paintThemeButton() {
    const dark = currentTheme() === 'dark';
    themeButton.innerHTML = icon(dark ? 'i-sun' : 'i-moon');
    themeButton.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', window.getComputedStyle(root).getPropertyValue('--paper').trim());
  }

  if (themeButton) {
    themeButton.addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.classList.add('theme-switching');
      root.setAttribute('data-theme', next);
      storage.set('quartz-eon.theme', next);
      paintThemeButton();
      window.setTimeout(() => root.classList.remove('theme-switching'), 350);
    });
    darkQuery.addEventListener('change', paintThemeButton);
    paintThemeButton();
  }

  /* ---------- Saved products count (the shop keeps the list in localStorage "qe-saved") ---------- */
  function paintSaved() {
    const badge = byId('saved-count');
    if (!badge) return;
    let count = 0;
    try {
      const list = JSON.parse(storage.get('qe-saved') || '[]');
      count = Array.isArray(list) ? list.filter((id) => typeof id === 'string').length : 0;
    } catch (e) { count = 0; }
    badge.textContent = String(count);
    badge.hidden = count === 0;
    byId('saved-link').setAttribute('aria-label', count ? `Saved products: ${count}` : 'Saved products');
  }
  paintSaved();

  /* Another tab changed the theme or the saved list */
  window.addEventListener('storage', (event) => {
    if (event.key === 'qe-saved') paintSaved();
    if (event.key === 'quartz-eon.theme' && (event.newValue === 'dark' || event.newValue === 'light')) {
      root.setAttribute('data-theme', event.newValue);
      if (themeButton) paintThemeButton();
    }
  });

  /* Back to top stays on this page */
  document.addEventListener('click', (event) => {
    if (!event.target.closest('a[href="#top"]')) return;
    event.preventDefault();
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
  });

  const year = byId('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
