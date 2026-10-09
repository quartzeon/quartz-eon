/* Quartz Eon storefront: plain JavaScript, no build step.
   Products and stores are read from Supabase (the public_products and public_stores views), and
   accounts use Supabase too — customer email-link log in, seller email/password log in, sign up
   and password reset, and an account menu that replaces the Log in button once someone is signed
   in. See js/supabase-client.js and supabase/schema.sql. */
(function () {
  'use strict';

  const CFG = Object.assign(
    { storeName: 'Quartz Eon', currencySymbol: 'Rs.', fallbackUsdRate: 330, sellerMonthlyFee: 500, categories: [] },
    window.QE_CONFIG
  );
  /* The catalogue is filled in by loadCatalog(). status: 'loading' | 'ready' | 'error' */
  const catalog = { status: 'loading' };
  let PRODUCTS = [];
  let SELLERS = [];
  let PRODUCT_BY_ID = new Map();
  let SELLER_BY_ID = new Map();
  let SELLER_BY_SLUG = new Map();
  const root = document.documentElement;
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  /* ---------- Helpers ---------- */
  const byId = (id) => document.getElementById(id);
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  const plural = (n, one, many) => (n === 1 ? one : many);
  const icon = (id) => `<svg class="i" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
  const art = (name) => `<svg class="art" aria-hidden="true" focusable="false"><use href="#a-${esc(name)}"/></svg>`;
  const hueOf = (item) => Number(item.hue) || 0;
  const sellerOf = (p) => SELLER_BY_ID.get(p.sellerId) || { id: '', slug: '', name: 'Unknown seller', about: '', hue: 0 };
  const storage = {
    get(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }
  };

  /* ---------- Theme ---------- */
  const themeButton = byId('theme-toggle');

  /* An explicit choice is stamped on <html data-theme>. With none, follow the device setting. */
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

  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    root.classList.add('theme-switching');
    root.setAttribute('data-theme', next);
    storage.set('quartz-eon.theme', next);
    paintThemeButton();
    window.setTimeout(() => root.classList.remove('theme-switching'), 350);
  }

  themeButton.addEventListener('click', toggleTheme);
  darkQuery.addEventListener('change', paintThemeButton);
  new MutationObserver(paintThemeButton).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  /* ---------- Log in menu (choose Customer or Seller, then the form opens) ---------- */
  const loginButton = byId('login-toggle');
  const loginMenu = byId('login-menu');
  const accountToggle = byId('account-toggle');
  const accountMenu = byId('account-menu');

  function setMenu(toggle, menu, open) {
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      const first = menu.querySelector('button, a');
      if (first) first.focus();
    }
  }

  loginButton.addEventListener('click', () => setMenu(loginButton, loginMenu, loginMenu.hidden));
  accountToggle.addEventListener('click', () => setMenu(accountToggle, accountMenu, accountMenu.hidden));

  loginMenu.addEventListener('click', (event) => {
    const option = event.target.closest('[data-role]');
    if (!option) return;
    setMenu(loginButton, loginMenu, false);
    openAuth(option.dataset.role, 'login');
  });

  byId('account-orders').addEventListener('click', () => setMenu(accountToggle, accountMenu, false));

  byId('account-logout').addEventListener('click', async () => {
    setMenu(accountToggle, accountMenu, false);
    await sb.auth.signOut();
  });

  /* Close on outside click, on Escape, and when keyboard focus leaves a menu. */
  document.addEventListener('click', (event) => {
    if (!loginMenu.hidden && !event.target.closest('#login-widget')) setMenu(loginButton, loginMenu, false);
    if (!accountMenu.hidden && !event.target.closest('#account')) setMenu(accountToggle, accountMenu, false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!loginMenu.hidden) { setMenu(loginButton, loginMenu, false); loginButton.focus(); }
    if (!accountMenu.hidden) { setMenu(accountToggle, accountMenu, false); accountToggle.focus(); }
  });
  loginMenu.addEventListener('focusout', (event) => {
    if (!loginMenu.hidden && event.relatedTarget && !event.relatedTarget.closest('#login-widget')) setMenu(loginButton, loginMenu, false);
  });
  accountMenu.addEventListener('focusout', (event) => {
    if (!accountMenu.hidden && event.relatedTarget && !event.relatedTarget.closest('#account')) setMenu(accountToggle, accountMenu, false);
  });

  /* ---------- Account: the real Supabase session (customer, seller or admin) ---------- */
  const sb = window.QE_SUPABASE;
  let session = null;
  let profile = null;
  let sellerRow = null;

  const redirectUrl = () => window.location.origin + window.location.pathname;

  async function loadProfile(userId) {
    const { data } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    return data || null;
  }

  async function loadSellerRow(userId) {
    const { data } = await sb.from('sellers').select('*').eq('id', userId).maybeSingle();
    return data || null;
  }

  /* A profile row is created the moment someone first signs in. A seller sign up carries the store
     details inside the account itself (user_metadata, set at sign up), so it works even when the
     email is confirmed later or on another device; everyone else becomes a customer. */
  async function ensureProfile(user) {
    const existing = await loadProfile(user.id);
    if (existing) return existing;
    const meta = user.user_metadata || {};
    if (meta.signup_role === 'seller' && meta.store_name && meta.store_slug) {
      const { error } = await sb.from('profiles').insert({ id: user.id, role: 'seller', email: user.email });
      if (!error) {
        const { error: storeError } = await sb.from('sellers').insert({ id: user.id, store_name: meta.store_name, store_slug: meta.store_slug, hue: Number(meta.hue) || 0 });
        /* Tell the owner (Telegram) that a store is waiting for approval. Failure here changes nothing for the seller. */
        if (!storeError) sb.functions.invoke('notify', { body: { kind: 'new_seller', id: user.id } }).catch(() => {});
      }
    } else {
      await sb.from('profiles').insert({ id: user.id, role: 'customer', email: user.email });
    }
    return loadProfile(user.id);
  }

  function paintAccountUI() {
    const loggedIn = !!session;
    byId('login-widget').hidden = loggedIn;
    byId('account').hidden = !loggedIn;
    if (!loggedIn) return;
    byId('account-email').textContent = session.user.email || '';
    const label = { seller: 'Seller', admin: 'Admin' }[profile && profile.role] || 'Account';
    byId('account-label').textContent = label;
    /* A seller goes from here to their dashboard; the owner to the admin page. */
    byId('account-dashboard').hidden = !(profile && profile.role === 'seller');
    byId('account-admin').hidden = !(profile && profile.role === 'admin');
    const dot = byId('account-dot');
    const note = byId('account-note');
    if (profile && profile.role === 'seller' && sellerRow) {
      dot.classList.toggle('is-pending', sellerRow.status !== 'approved');
      if (sellerRow.status === 'pending') { note.hidden = false; note.textContent = 'Your store is waiting for approval.'; }
      else if (sellerRow.status === 'suspended') { note.hidden = false; note.textContent = 'Your store is currently hidden. Contact us to reactivate it.'; }
      else note.hidden = true;
    } else {
      dot.classList.remove('is-pending');
      note.hidden = true;
    }
  }

  /* status: 'idle' | 'loading' | 'ready' | 'error' */
  const ordersState = { status: 'idle', rows: [], reviews: new Map(), editing: new Set() };

  sb.auth.onAuthStateChange(async (event, newSession) => {
    session = newSession;
    if (session) {
      profile = await ensureProfile(session.user);
      sellerRow = profile && profile.role === 'seller' ? await loadSellerRow(session.user.id) : null;
    } else {
      profile = null;
      sellerRow = null;
    }
    paintAccountUI();
    if (event === 'SIGNED_IN' && authDialog.open) {
      authDialog.close();
      /* A seller who just logged in through the Seller form lands straight on their dashboard. */
      if (auth.role === 'seller' && profile && profile.role === 'seller') window.location.href = 'seller.html';
    }
    ordersState.status = 'idle';
    if (view.name === 'orders') renderOrders();
  });

  /* ---------- Money: prices are in rupees, dollars are worked out from the live rate ---------- */
  const RATE_KEY = 'quartz-eon.usd-lkr';
  const RATE_MAX_AGE = 12 * 60 * 60 * 1000;
  const RATE_SOURCES = [
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    'https://latest.currency-api.pages.dev/v1/currencies/usd.json'
  ];
  /* status: 'loading' until the first answer, then 'live' (real rate) or 'fallback' (config value) */
  const rate = { value: CFG.fallbackUsdRate, date: '', status: 'loading' };

  const money2 = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dollars = (n) => `$${money2(n / rate.value)}`;
  const rupeeNumber = (n) => Math.round(n).toLocaleString('en-US');

  /* What a price looks like. With several options and none chosen it reads "From Rs. ...". */
  function priceHtml(p, optionIndex) {
    const options = p.options || [];
    const chosen = Number.isInteger(optionIndex) ? options[optionIndex] : null;
    const amount = chosen ? chosen.price : p.price;
    const from = !chosen && options.length > 1 ? '<span class="price__from">From</span> ' : '';
    return `
      <span class="price">${from}<span class="price__cur">${esc(CFG.currencySymbol)}</span>${rupeeNumber(amount)}</span>
      <span class="usd" title="Approximate, at the current exchange rate">&asymp; ${dollars(amount)}</span>`;
  }

  /* The public address of a product photo. */
  const photoUrl = (path) => sb.storage.from('product-images').getPublicUrl(path).data.publicUrl;
  /* A logo is an uploaded file, or a brand picked from the library (saved as "si:<name>"). */
  const logoUrl = (value) => (String(value).startsWith('si:') ? ('https://cdn.simpleicons.org/' + encodeURIComponent(String(value).slice(3))) : photoUrl(value));

  /* The price and name of what is being bought: the product, or one of its options. */
  function offerOf(p, optionIndex) {
    const chosen = Number.isInteger(optionIndex) ? (p.options || [])[optionIndex] : null;
    return { price: chosen ? chosen.price : p.price, label: chosen ? chosen.label : '' };
  }

  function formatDate(iso) {
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function renderRateNote() {
    const per = `1 USD = ${CFG.currencySymbol} ${money2(rate.value)}`;
    const base = 'Prices are in Sri Lankan rupees. Dollar amounts are approximate';
    let text;
    if (rate.status === 'live') text = `${base}, at ${per}${rate.date ? ` (rate of ${formatDate(rate.date)})` : ''}.`;
    else if (rate.status === 'fallback') text = `${base}, using an estimated ${per} because the live rate could not be loaded.`;
    else text = `${base}. Loading the live exchange rate.`;
    byId('rate-note').textContent = text;
  }

  function applyRate(value, date, status) {
    rate.value = value;
    rate.date = date;
    rate.status = status;
    renderCurrentView();
    renderRateNote();
  }

  function readCachedRate() {
    try {
      const cached = JSON.parse(storage.get(RATE_KEY));
      if (cached && cached.value > 50 && cached.value < 2000) return cached;
    } catch (e) { /* no usable cache */ }
    return null;
  }

  async function fetchRate() {
    for (const url of RATE_SOURCES) {
      try {
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) continue;
        const data = await response.json();
        const value = Number(data && data.usd && data.usd.lkr);
        if (value > 50 && value < 2000) return { value, date: data.date || '', fetchedAt: Date.now() };
      } catch (e) { /* try the next source */ }
    }
    return null;
  }

  async function loadRate() {
    const cached = readCachedRate();
    if (cached) {
      applyRate(cached.value, cached.date, 'live');
      if (Date.now() - cached.fetchedAt < RATE_MAX_AGE) return;
    }
    const fresh = await fetchRate();
    if (fresh) {
      storage.set(RATE_KEY, JSON.stringify(fresh));
      applyRate(fresh.value, fresh.date, 'live');
    } else if (!cached) {
      applyRate(CFG.fallbackUsdRate, '', 'fallback');
    }
  }

  /* ---------- Stars ---------- */
  /* Five stars filled up to the rating (halves allowed, e.g. 4.5). */
  function starsHtml(value) {
    const pct = Math.max(0, Math.min(5, Number(value) || 0)) * 20;
    const row = icon('i-star').repeat(5);
    return `<span class="stars" role="img" aria-label="${esc(value)} out of 5 stars"><span class="stars__base">${row}</span><span class="stars__fill" style="width:${pct}%">${row}</span></span>`;
  }
  /* "4.5 (12)" under a product name; nothing when there are no reviews yet. On a product card it opens the
     product page; on the product page it scrolls down to the reviews. */
  function ratingLine(p, onPage) {
    if (!p.ratingCount) return '';
    const inner = `${starsHtml(p.ratingAvg)}<span>${p.ratingAvg.toFixed(1)} (${p.ratingCount} ${plural(p.ratingCount, 'review', 'reviews')})</span>`;
    return onPage
      ? `<p><button class="rating rating--link" type="button" data-jump-reviews>${inner}</button></p>`
      : `<p><a class="rating rating--link" href="#/product/${esc(p.id)}">${inner}</a></p>`;
  }

  /* ---------- Product cards ---------- */
  /* A "plan card" product in a list: the same card as on its page (logo, badge, key figures, detail lines), then Details and Buy now. */
  function planTile(p, showSeller) {
    const seller = sellerOf(p);
    const href = `#/product/${esc(p.id)}`;
    const stat = (s) => `<div class="pc__stat"><strong class="${String(s.value).length > 6 ? 'is-long' : ''}">${esc(s.value)}</strong>${s.label ? `<span>${esc(s.label)}</span>` : ''}</div>`;
    return `
      <article class="pc pc--tile${p.soldOut ? ' is-soldout' : ''}" style="--h:${hueOf(p)}">
        <header class="pc__head">
          ${p.logo ? `<img class="pc__logo" src="${esc(logoUrl(p.logo))}" alt="" loading="lazy">` : `<span class="pc__logo pc__logo--art">${art(p.icon)}</span>`}
          <div>
            <h3 class="pc__title"><a href="${href}">${esc(p.name)}</a></h3>
            ${p.badge ? `<span class="pc__badge">${icon('i-shield')}${esc(p.badge)}</span>` : ''}
            ${ratingLine(p)}
          </div>
        </header>
        <div class="pc__stats">
          ${p.stats.map(stat).join('')}
          <div class="pc__stat pc__stat--price"><div class="product__price pd__price">${priceHtml(p)}</div></div>
        </div>
        ${p.info.length ? `<ul class="pc__info">${p.info.map((row) => `<li>${icon(`i-${esc(row.icon)}`)}<span>${esc(row.text)}</span></li>`).join('')}</ul>` : ''}
        ${showSeller ? `<p class="product__seller">by ${seller.slug ? `<a href="#/store/${esc(seller.slug)}">${esc(seller.name)}</a>${verifiedBadge(seller)}` : esc(seller.name)}</p>` : ''}
        <div class="pc__foot">
          <a class="link" href="${href}">Details &rarr;</a>
          <a class="btn ${p.soldOut ? 'btn--ghost' : 'btn--ink'} pc__buy" href="${href}">${p.soldOut ? 'Sold out' : 'Buy now'}</a>
        </div>
      </article>`;
  }

  function productTile(p, showSeller) {
    if (p.theme === 'plan') return planTile(p, showSeller);
    const seller = sellerOf(p);
    const sellerLine = showSeller
      ? `<p class="product__seller">by ${seller.slug ? `<a href="#/store/${esc(seller.slug)}">${esc(seller.name)}</a>${verifiedBadge(seller)}` : esc(seller.name)}</p>`
      : '';
    const href = `#/product/${esc(p.id)}`;
    return `
      <article class="product${p.soldOut ? ' is-soldout' : ''}" style="--h:${hueOf(p)}">
        <a class="product__art" href="${href}" aria-label="${esc(p.name)}">
          ${p.theme === 'plan' && p.logo ? `<img class="product__logo" src="${esc(logoUrl(p.logo))}" alt="" loading="lazy">`
            : p.images.length ? `<img class="product__photo" src="${esc(photoUrl(p.images[0]))}" alt="" loading="lazy">` : art(p.icon)}
          ${p.theme === 'plan' && p.badge ? `<span class="badge">${esc(p.badge)}</span>` : p.type ? `<span class="badge">${esc(p.type)}</span>` : ''}
          ${p.soldOut ? '<span class="badge badge--soldout">Sold out</span>' : ''}
        </a>
        <div class="product__info">
          <p class="product__cat">${esc(p.category)}</p>
          <h3 class="product__name"><a href="${href}">${esc(p.name)}</a></h3>
          ${ratingLine(p)}
          ${sellerLine}
          <div class="product__buy">
            <p class="product__price">${priceHtml(p)}</p>
            <a class="btn ${p.soldOut ? 'btn--ghost' : 'btn--ink'} btn--sm" href="${href}" aria-label="${p.soldOut ? 'See' : 'Buy'} ${esc(p.name)}">${p.soldOut ? 'Details' : 'Buy'}</a>
          </div>
        </div>
      </article>`;
  }

  /* ---------- Catalogue: approved stores and their active products, from Supabase ---------- */
  let catalogRequest = 0;

  async function loadCatalog() {
    const request = ++catalogRequest;
    catalog.status = 'loading';
    renderCurrentView();
    const [stores, products, ratings] = await Promise.all([
      sb.from('public_stores').select('*'),
      sb.from('public_products').select('*').order('created_at', { ascending: false }),
      sb.from('public_product_ratings').select('*')
    ]);
    /* Ratings are extra: if they fail to load the shop still works, just without stars. */
    const RATING_BY_ID = new Map(((ratings && ratings.data) || []).map((r) => [r.product_id, r]));
    if (request !== catalogRequest) return; /* a newer load has started; ignore this answer */
    if (stores.error || products.error) {
      catalog.status = 'error';
    } else {
      SELLERS = stores.data.map((s) => ({ id: s.id, slug: s.store_slug, name: s.store_name, about: s.about, hue: s.hue, logo: s.logo || '', whatsapp: s.contact_whatsapp || '', telegram: s.contact_telegram || '', facebook: s.social_facebook || '', instagram: s.social_instagram || '', website: s.social_website || '', verified: !!s.verified, availabilityMode: s.availability_mode || 'none', availabilityHours: Array.isArray(s.availability_hours) ? s.availability_hours : [] }));
      SELLER_BY_ID = new Map(SELLERS.map((s) => [s.id, s]));
      SELLER_BY_SLUG = new Map(SELLERS.map((s) => [s.slug, s]));
      PRODUCTS = products.data.map((p) => ({
        id: p.id,
        sellerId: p.seller_id,
        name: p.name,
        category: p.category,
        price: p.price,
        type: p.type,
        description: p.description,
        icon: p.icon,
        images: Array.isArray(p.images) ? p.images : [],
        options: Array.isArray(p.options) ? p.options : [],
        stockLeft: p.stock_left == null ? null : p.stock_left,
        soldOut: !!p.sold_out,
        vpnDays: p.vpn_days,
        vpnGb: p.vpn_data_gb,
        theme: p.theme === 'plan' ? 'plan' : 'standard',
        logo: p.logo || '',
        badge: p.badge || '',
        stats: Array.isArray(p.stats) ? p.stats : [],
        info: Array.isArray(p.info) ? p.info : [],
        ratingAvg: Number((RATING_BY_ID.get(p.id) || {}).rating_avg) || 0,
        ratingCount: Number((RATING_BY_ID.get(p.id) || {}).rating_count) || 0,
        hue: (SELLER_BY_ID.get(p.seller_id) || {}).hue || 0
      }));
      PRODUCT_BY_ID = new Map(PRODUCTS.map((p) => [p.id, p]));
      catalog.status = 'ready';
    }
    renderChips();
    route();
  }

  /* ---------- Home page: search, categories, sort ---------- */
  const state = { cat: 'All', q: '', sort: 'featured' };
  const categoryNames = () => (CFG.categories.length ? CFG.categories : Array.from(new Set(PRODUCTS.map((p) => p.category))));
  const countIn = (name) => PRODUCTS.filter((p) => name === 'All' || p.category === name).length;

  function matches(p, query) {
    if (!query) return true;
    const haystack = `${p.name} ${p.category} ${sellerOf(p).name} ${p.type || ''}`.toLowerCase();
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
  }

  function visibleProducts() {
    const list = PRODUCTS.filter((p) => (state.cat === 'All' || p.category === state.cat) && matches(p, state.q));
    const order = {
      low: (a, b) => a.price - b.price,
      high: (a, b) => b.price - a.price,
      name: (a, b) => a.name.localeCompare(b.name)
    }[state.sort];
    return order ? list.sort(order) : list;
  }

  /* The box under the grid doubles as the loading, error and "nothing found" message. */
  function showNotice(title, text, action) {
    byId('empty-title').textContent = title;
    byId('empty-text').textContent = text;
    byId('clear-filters').hidden = action !== 'clear';
    byId('retry-load').hidden = action !== 'retry';
    byId('empty').hidden = false;
  }

  /* The blue tick (like Telegram's) next to a store whose monthly fee is paid. */
  function verifiedBadge(seller, large) {
    if (!seller || !seller.verified) return '';
    return `<span class="vbadge${large ? ' vbadge--lg' : ''}" title="Verified store" aria-label="Verified store"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 1.8l2.4 1.7 2.9-.2 1.1 2.7 2.5 1.5-.5 2.9 1.2 2.7-1.9 2.2-.2 2.9-2.8.9-1.8 2.3-2.7-1.1-2.7 1.1-1.8-2.3-2.8-.9-.2-2.9L2.3 12.4l1.2-2.7-.5-2.9 2.5-1.5 1.1-2.7 2.9.2z" fill="currentColor" stroke="none"/><path d="M8 12.3l2.6 2.6L16 9.5" fill="none" stroke="#fff" stroke-width="2"/></svg></span>`;
  }

  /* ---------- How to reach a seller ---------- */
  const brandIcon = (slug) => `<img class="social__icon" src="https://cdn.simpleicons.org/${slug}" alt="" width="22" height="22" loading="lazy">`;

  /* The icon buttons shown next to a store's name: WhatsApp, Telegram, Facebook, Instagram, website. */
  function socialLinksHtml(seller) {
    const links = [
      seller.whatsapp && { href: `https://wa.me/${seller.whatsapp}`, label: 'WhatsApp', icon: brandIcon('whatsapp') },
      seller.telegram && { href: `https://t.me/${seller.telegram}`, label: 'Telegram', icon: brandIcon('telegram') },
      seller.facebook && { href: seller.facebook, label: 'Facebook', icon: brandIcon('facebook') },
      seller.instagram && { href: seller.instagram, label: 'Instagram', icon: brandIcon('instagram') },
      seller.website && { href: seller.website, label: 'Website', icon: icon('i-globe') }
    ].filter(Boolean);
    if (!links.length) return '';
    return `<div class="social" aria-label="${esc(seller.name)} on the web">${links.map((l) => `
      <a class="social__btn" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer" title="${esc(l.label)}" aria-label="${esc(l.label)}">${l.icon}</a>`).join('')}</div>`;
  }

  /* ---------- Online / Away, like WhatsApp Business ---------- */
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const SL_ZONE = 'Asia/Colombo'; /* the hours are Sri Lanka time, whatever the visitor's clock says */

  const clockMinutes = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
  function clockText(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }

  function colomboNow() {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: SL_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
    return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
  }

  /* { online, text } for a seller, or null when they chose not to show a status. */
  function availabilityOf(seller) {
    if (seller.availabilityMode === 'always') return { online: true, text: 'Online' };
    if (seller.availabilityMode === 'away') return { online: false, text: 'Away' };
    if (seller.availabilityMode !== 'hours' || seller.availabilityHours.length !== 7) return null;
    const week = seller.availabilityHours;
    const now = colomboNow();
    const today = week[now.day];
    if (today.open && now.minutes >= clockMinutes(today.from) && now.minutes < clockMinutes(today.to)) {
      return { online: true, text: `Online · until ${clockText(today.to)}` };
    }
    if (today.open && now.minutes < clockMinutes(today.from)) return { online: false, text: `Away · back today at ${clockText(today.from)}` };
    for (let ahead = 1; ahead <= 7; ahead += 1) {
      const day = (now.day + ahead) % 7;
      if (week[day].open) return { online: false, text: `Away · back ${ahead === 1 ? 'tomorrow' : DAY_NAMES[day]} at ${clockText(week[day].from)}` };
    }
    return { online: false, text: 'Away' };
  }

  /* The green or grey dot and text. withHours adds the weekly opening hours underneath. */
  function presenceHtml(seller, withHours) {
    const a = availabilityOf(seller);
    if (!a) return '';
    const hours = withHours && seller.availabilityMode === 'hours' && seller.availabilityHours.length === 7 ? `
      <details class="hours">
        <summary>Opening hours</summary>
        <ul>${seller.availabilityHours.map((h, i) => `<li><span>${DAY_NAMES[i]}</span><span>${h.open ? `${clockText(h.from)} – ${clockText(h.to)}` : 'Closed'}</span></li>`).join('')}</ul>
        <p>Sri Lanka time.</p>
      </details>` : '';
    return `<div class="presence-wrap"><span class="presence ${a.online ? 'presence--on' : 'presence--off'}"><i aria-hidden="true"></i>${esc(a.text)}</span>${hours}</div>`;
  }

  /* On a product page: ready-made WhatsApp and Telegram buttons to ask the seller about this product. */
  function sellerContactHtml(seller, product) {
    if (!seller.whatsapp && !seller.telegram) return '';
    const message = encodeURIComponent(`Hi, I am interested in "${product.name}" on ${CFG.storeName}.`);
    return `
      <div class="contact">
        <p class="contact__title">Questions? Contact ${esc(seller.name)}</p>
        ${presenceHtml(seller, false)}
        <div class="contact__buttons">
          ${seller.whatsapp ? `<a class="btn btn--ghost" href="https://wa.me/${esc(seller.whatsapp)}?text=${message}" target="_blank" rel="noopener noreferrer">${brandIcon('whatsapp')}<span>WhatsApp</span></a>` : ''}
          ${seller.telegram ? `<a class="btn btn--ghost" href="https://t.me/${esc(seller.telegram)}" target="_blank" rel="noopener noreferrer">${brandIcon('telegram')}<span>Telegram</span></a>` : ''}
        </div>
      </div>`;
  }

  /* A seller's logo (a file in the product-images bucket), or their initials when they have not added one. */
  function sellerLogoHtml(seller, className) {
    return seller.logo
      ? `<span class="${className}"><img src="${esc(photoUrl(seller.logo))}" alt="" loading="lazy"></span>`
      : `<span class="${className}" aria-hidden="true">${esc(initials(seller.name))}</span>`;
  }

  /* When a category is chosen, the sellers who sell in it are listed first, each with their logo and name. */
  function renderSellersStrip() {
    const box = byId('sellers-strip');
    if (catalog.status !== 'ready' || state.cat === 'All') { box.hidden = true; box.innerHTML = ''; return; }
    const counts = new Map();
    PRODUCTS.filter((p) => p.category === state.cat).forEach((p) => counts.set(p.sellerId, (counts.get(p.sellerId) || 0) + 1));
    const sellers = SELLERS.filter((s) => counts.has(s.id)).sort((a, b) => a.name.localeCompare(b.name));
    if (!sellers.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = `
      <p class="sellers-strip__title">${sellers.length} ${plural(sellers.length, 'seller', 'sellers')} in ${esc(state.cat)}</p>
      <div class="sellers-strip__list">${sellers.map((s) => `
        <a class="seller-chip" href="#/store/${esc(s.slug)}" style="--h:${hueOf(s)}">
          ${sellerLogoHtml(s, 'seller-chip__logo')}
          <span class="seller-chip__text">
            <span class="seller-chip__name">${(availabilityOf(s) || {}).online ? '<i class="presence-dot" title="Online now" aria-label="Online now"></i>' : ''}${esc(s.name)}${verifiedBadge(s)}</span>
            <span class="seller-chip__count">${counts.get(s.id)} ${plural(counts.get(s.id), 'product', 'products')}</span>
          </span>
        </a>`).join('')}</div>`;
    box.hidden = false;
  }

  function renderProducts() {
    renderSellersStrip();
    if (catalog.status !== 'ready') {
      byId('grid').innerHTML = '';
      byId('grid').hidden = true;
      byId('result-count').textContent = '';
      if (catalog.status === 'loading') showNotice('Loading products', 'One moment.', '');
      else showNotice('Could not load products', 'Check your connection and try again.', 'retry');
      return;
    }
    const list = visibleProducts();
    byId('grid').innerHTML = list.map((p) => productTile(p, true)).join('');
    byId('grid').hidden = list.length === 0;
    if (list.length) byId('empty').hidden = true;
    else if (PRODUCTS.length === 0) showNotice('No products yet', 'Sellers are still setting up their stores. Please check back soon.', '');
    else showNotice('Nothing matches that search', 'Try a different word or clear the filters.', 'clear');
    byId('result-count').textContent = `${list.length} ${plural(list.length, 'product', 'products')}${state.cat === 'All' ? '' : ` in ${state.cat}`}`;
  }

  function renderChips() {
    byId('chips').innerHTML = ['All', ...categoryNames()].map((name) => `
      <button class="chip" type="button" data-filter="${esc(name)}" aria-pressed="${state.cat === name}">${esc(name)} <small>${countIn(name)}</small></button>`).join('');
  }

  byId('chips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter]');
    if (!chip) return;
    state.cat = chip.dataset.filter;
    renderChips();
    renderProducts();
    const again = byId('chips').querySelector('[aria-pressed="true"]');
    if (again) again.focus();
  });
  byId('q').addEventListener('input', (event) => {
    state.q = event.target.value.trim();
    renderProducts();
  });
  byId('sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderProducts();
  });
  byId('retry-load').addEventListener('click', loadCatalog);
  byId('clear-filters').addEventListener('click', () => {
    state.cat = 'All';
    state.q = '';
    byId('q').value = '';
    renderChips();
    renderProducts();
  });

  /* ---------- Seller store pages (address: index.html#/store/<seller id>) ---------- */
  const homeView = byId('home-view');
  const storeView = byId('store-view');
  const ordersView = byId('orders-view');
  const productView = byId('product-view');
  const view = { name: 'home', slug: '' };
  const DEFAULT_DESCRIPTION = 'Quartz Eon is a marketplace for digital products: templates, e-books, courses, software and design assets from independent sellers.';

  const initials = (name) => name.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w.charAt(0))).slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase();

  function renderStore() {
    if (catalog.status !== 'ready') {
      const failed = catalog.status === 'error';
      storeView.innerHTML = `
        <section class="sec tone tone--paper">
          <div class="wrap">
            <div class="empty">
              <p class="empty__title">${failed ? 'Could not load this store' : 'Loading store'}</p>
              <p>${failed ? 'Check your connection and try again.' : 'One moment.'}</p>
              ${failed ? '<button class="btn btn--ink" type="button" id="retry-store">Try again</button>' : ''}
            </div>
          </div>
        </section>`;
      const retry = byId('retry-store');
      if (retry) retry.addEventListener('click', loadCatalog);
      return;
    }
    const seller = SELLER_BY_SLUG.get(view.slug);
    if (!seller) {
      storeView.innerHTML = `
        <section class="sec tone tone--paper">
          <div class="wrap">
            <div class="empty">
              <p class="empty__title">Store not found</p>
              <p>There is no seller store at this address.</p>
              <a class="btn btn--ink" href="#/">Back to all products</a>
            </div>
          </div>
        </section>`;
      return;
    }
    const list = PRODUCTS.filter((p) => p.sellerId === seller.id);
    const categories = Array.from(new Set(list.map((p) => p.category)));
    storeView.innerHTML = `
      <section class="store-head tone" style="--h:${hueOf(seller)}" aria-labelledby="store-title">
        <div class="wrap">
          <a class="back" href="#/">${icon('i-back')}<span>All products</span></a>
          <div class="store-head__row">
            ${sellerLogoHtml(seller, `store-avatar${seller.logo ? ' store-avatar--img' : ''}`)}
            <div>
              <p class="eyebrow">Seller store</p>
              <h1 class="store-title" id="store-title">${esc(seller.name)}${verifiedBadge(seller, true)}</h1>
              ${seller.about ? `<p class="store-about">${esc(seller.about)}</p>` : ''}
              ${presenceHtml(seller, true)}
              ${socialLinksHtml(seller)}
              <p class="store-meta">${list.length} ${plural(list.length, 'product', 'products')}${categories.length ? ` &middot; ${esc(categories.join(', '))}` : ''}</p>
            </div>
          </div>
        </div>
      </section>
      <section class="sec tone tone--paper" aria-label="Products from ${esc(seller.name)}">
        <div class="wrap">
          ${list.length
            ? `<div class="grid">${list.map((p) => productTile(p, false)).join('')}</div>`
            : '<p class="note">This seller has no products yet.</p>'}
        </div>
      </section>`;
  }

  function renderCurrentView() {
    if (view.name === 'store') renderStore();
    else if (view.name === 'orders') renderOrders();
    else if (view.name === 'product') renderProduct();
    else renderProducts();
  }

  function route() {
    const hash = window.location.hash;
    const store = hash.match(/^#\/store\/([\w-]+)$/);
    const product = hash.match(/^#\/product\/([\w-]+)$/);
    const next = hash === '#/orders'
      ? { name: 'orders', slug: '' }
      : product ? { name: 'product', slug: product[1] }
      : store ? { name: 'store', slug: store[1] } : { name: 'home', slug: '' };
    const changed = next.name !== view.name || next.slug !== view.slug;
    if (changed) page.productId = '';
    view.name = next.name;
    view.slug = next.slug;
    homeView.hidden = view.name !== 'home';
    storeView.hidden = view.name !== 'store';
    ordersView.hidden = view.name !== 'orders';
    productView.hidden = view.name !== 'product';
    const seller = SELLER_BY_SLUG.get(view.slug);
    const item = view.name === 'product' ? PRODUCT_BY_ID.get(view.slug) : null;
    document.title = view.name === 'store' && seller ? `${seller.name} | ${CFG.storeName}`
      : item ? `${item.name} | ${CFG.storeName}`
      : view.name === 'orders' ? `My orders | ${CFG.storeName}` : CFG.storeName;
    const description = item ? (item.description || DEFAULT_DESCRIPTION).slice(0, 160)
      : view.name === 'store' && seller && seller.about ? seller.about : DEFAULT_DESCRIPTION;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', description);
    renderCurrentView();
    if (changed) window.scrollTo({ top: 0, behavior: 'instant' });
  }

  window.addEventListener('hashchange', route);

  /* ---------- Product page (address: index.html#/product/<id>) ---------- */
  const buyDialog = byId('buy');
  const page = { productId: '', option: null, image: 0 };

  /* A click on the dark backdrop closes the checkout dialog. Page scrolling is locked in CSS while a dialog is open. */
  buyDialog.addEventListener('click', (event) => {
    if (event.target === buyDialog) buyDialog.close();
  });

  /* Blank lines in the seller's text make paragraphs; single line breaks are kept. */
  function paragraphs(text) {
    return String(text || '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
      .map((part) => `<p>${esc(part).replace(/\n/g, '<br>')}</p>`).join('');
  }

  function planText(days, gb) {
    const length = days > 0 ? `Valid for ${days} ${plural(days, 'day', 'days')}` : '';
    return [length, gb > 0 ? `${gb} GB of data` : 'Unlimited data'].filter(Boolean).join(' · ');
  }

  /* The state of the Buy button on the product page. */
  function purchaseState(p) {
    if (p.soldOut) return { text: 'Sold out', disabled: true };
    if (p.options.length && page.option === null) return { text: 'Choose an option', disabled: true };
    return { text: 'Buy now', disabled: false };
  }

  function updatePurchase(p) {
    const price = byId('pd-price');
    const button = byId('pd-buy');
    if (price) price.innerHTML = priceHtml(p, page.option);
    if (button) {
      const state = purchaseState(p);
      button.textContent = state.text;
      button.disabled = state.disabled;
    }
  }

  function renderProduct() {
    if (catalog.status !== 'ready') {
      const failed = catalog.status === 'error';
      productView.innerHTML = `
        <section class="sec tone tone--paper"><div class="wrap"><div class="empty">
          <p class="empty__title">${failed ? 'Could not load this product' : 'Loading product'}</p>
          <p>${failed ? 'Check your connection and try again.' : 'One moment.'}</p>
          ${failed ? '<button class="btn btn--ink" type="button" id="retry-product">Try again</button>' : ''}
        </div></div></section>`;
      const retry = byId('retry-product');
      if (retry) retry.addEventListener('click', loadCatalog);
      return;
    }
    const p = PRODUCT_BY_ID.get(view.slug);
    if (!p) {
      productView.innerHTML = `
        <section class="sec tone tone--paper"><div class="wrap"><div class="empty">
          <p class="empty__title">Product not found</p>
          <p>This product is not for sale any more, or the address is wrong.</p>
          <a class="btn btn--ink" href="#/">Back to all products</a>
        </div></div></section>`;
      return;
    }
    if (page.productId !== p.id) {
      page.productId = p.id;
      page.option = p.options.length === 1 && !p.options[0].soldOut ? 0 : null;
      page.image = 0;
    }
    const seller = sellerOf(p);
    const contactHtml = sellerContactHtml(seller, p);
    const gallery = `
      <div class="pd__main">
        ${p.images.length ? `<img id="pd-main-img" src="${esc(photoUrl(p.images[page.image] || p.images[0]))}" alt="${esc(p.name)}">` : `<div class="pd__art">${art(p.icon)}</div>`}
        ${p.soldOut ? '<span class="badge badge--soldout">Sold out</span>' : ''}
      </div>
      ${p.images.length > 1 ? `<div class="pd__thumbs">${p.images.map((path, i) => `
        <button class="pd__thumb" type="button" data-pd-img="${i}" aria-pressed="${i === page.image}" aria-label="Show photo ${i + 1}"><img src="${esc(photoUrl(path))}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}`;

    const options = p.options.length ? `
      <fieldset class="pd-options">
        <legend>Choose an option</legend>
        ${p.options.map((o, i) => `
          <label class="pd-option${o.soldOut ? ' is-disabled' : ''}">
            <input type="radio" name="pd-option" value="${i}" ${o.soldOut ? 'disabled' : ''} ${page.option === i ? 'checked' : ''}>
            <span class="pd-option__name">${esc(o.label)}${p.icon === 'vpn' && o.days ? `<small>${esc(planText(o.days, o.gb))}</small>` : ''}</span>
            <span class="pd-option__price">${esc(CFG.currencySymbol)} ${rupeeNumber(o.price)}</span>
            <span class="pd-option__stock">${o.soldOut ? 'Sold out' : o.left != null ? `${o.left} left` : ''}</span>
          </label>`).join('')}
      </fieldset>` : '';

    const perks = [
      'Delivered to your account once payment is confirmed',
      p.icon === 'vpn' && !p.options.length ? planText(p.vpnDays, p.vpnGb) : '',
      p.type ? `File type: ${p.type}` : '',
      `Sold by ${seller.name}`
    ].filter(Boolean);

    const state = purchaseState(p);

    /* The "plan card" style: a logo, a badge, key figures, detail lines with icons, then the Buy button. */
    if (p.theme === 'plan') {
      const stat = (s) => `<div class="pc__stat"><strong class="${String(s.value).length > 6 ? 'is-long' : ''}">${esc(s.value)}</strong>${s.label ? `<span>${esc(s.label)}</span>` : ''}</div>`;
      productView.innerHTML = `
        <section class="sec tone tone--paper" aria-labelledby="pd-title">
          <div class="wrap">
            <a class="back" href="${seller.slug ? `#/store/${esc(seller.slug)}` : '#/'}">${icon('i-back')}<span>${seller.slug ? esc(seller.name) : 'All products'}</span></a>
            <article class="pc${p.soldOut ? ' is-soldout' : ''}" style="--h:${hueOf(p)}">
              <header class="pc__head">
                ${p.logo ? `<img class="pc__logo" src="${esc(logoUrl(p.logo))}" alt="">` : `<span class="pc__logo pc__logo--art">${art(p.icon)}</span>`}
                <div>
                  <h1 class="pc__title" id="pd-title">${esc(p.name)}</h1>
                  ${p.badge ? `<span class="pc__badge">${icon('i-shield')}${esc(p.badge)}</span>` : ''}
                  ${ratingLine(p, true)}
                </div>
              </header>
              <div class="pc__stats">
                ${p.stats.map(stat).join('')}
                <div class="pc__stat pc__stat--price"><div class="product__price pd__price" id="pd-price">${priceHtml(p, page.option)}</div></div>
              </div>
              ${p.info.length ? `<ul class="pc__info">${p.info.map((row) => `<li>${icon(`i-${esc(row.icon)}`)}<span>${esc(row.text)}</span></li>`).join('')}</ul>` : ''}
              ${!p.options.length && !p.soldOut && p.stockLeft != null ? `<p class="pd__stock">${p.stockLeft === 1 ? 'Only 1 left' : `${p.stockLeft} left`}</p>` : ''}
              ${options}
              <button class="btn btn--ink btn--block pd__buy pc__buy" type="button" id="pd-buy" ${state.disabled ? 'disabled' : ''}>${state.text}</button>
              ${p.description ? `<div class="pd__desc">${paragraphs(p.description)}</div>` : ''}
              <ul class="buy__list">${perks.map((text) => `<li>${icon('i-check')}<span>${esc(text)}</span></li>`).join('')}</ul>${contactHtml}
            </article>
            <div class="reviews" id="pd-reviews" aria-live="polite"></div>
          </div>
        </section>`;
      renderReviews(p);
      return;
    }

    productView.innerHTML = `
      <section class="sec tone tone--paper" aria-labelledby="pd-title">
        <div class="wrap">
          <a class="back" href="${seller.slug ? `#/store/${esc(seller.slug)}` : '#/'}">${icon('i-back')}<span>${seller.slug ? esc(seller.name) : 'All products'}</span></a>
          <div class="pd" style="--h:${hueOf(p)}">
            <div class="pd__gallery">${gallery}</div>
            <div class="pd__info">
              <p class="product__cat">${esc(p.category)}</p>
              <h1 class="pd__title" id="pd-title">${esc(p.name)}</h1>
              <p class="product__seller">by ${seller.slug ? `<a href="#/store/${esc(seller.slug)}">${esc(seller.name)}</a>${verifiedBadge(seller)}` : esc(seller.name)}</p>
              ${ratingLine(p, true)}
              <p class="product__price pd__price" id="pd-price">${priceHtml(p, page.option)}</p>
              ${!p.options.length && !p.soldOut && p.stockLeft != null ? `<p class="pd__stock">${p.stockLeft === 1 ? 'Only 1 left' : `${p.stockLeft} left`}</p>` : ''}
              ${options}
              <button class="btn btn--ink btn--block pd__buy" type="button" id="pd-buy" ${state.disabled ? 'disabled' : ''}>${state.text}</button>
              ${p.description ? `<div class="pd__desc">${paragraphs(p.description)}</div>` : ''}
              <ul class="buy__list">${perks.map((text) => `<li>${icon('i-check')}<span>${esc(text)}</span></li>`).join('')}</ul>${contactHtml}
            </div>
          </div>
          <div class="reviews" id="pd-reviews" aria-live="polite"></div>
        </div>
      </section>`;
    renderReviews(p);
  }

  /* ---------- Reviews on the product page ---------- */
  /* productId -> { status: 'loading' | 'ready' | 'error', rows } */
  const reviewsCache = new Map();

  async function loadReviews(p) {
    reviewsCache.set(p.id, { status: 'loading', rows: [] });
    const { data, error } = await sb.from('public_reviews').select('*').eq('product_id', p.id).order('created_at', { ascending: false }).limit(50);
    reviewsCache.set(p.id, { status: error ? 'error' : 'ready', rows: data || [] });
    if (view.name === 'product' && view.slug === p.id) renderReviews(p);
  }

  function reviewHtml(r) {
    const isAdmin = profile && profile.role === 'admin';
    return `
      <li class="review">
        <div class="review__head">
          ${starsHtml(r.rating)}
          <span class="review__who">${esc(r.reviewer)} &middot; Verified buyer &middot; ${esc(formatDate(String(r.created_at).slice(0, 10)))}</span>
          ${isAdmin ? `<button class="link review__delete" type="button" data-delete-review="${esc(r.id)}">Delete</button>` : ''}
        </div>
        ${r.comment ? `<p class="review__text">${esc(r.comment).replace(/\n/g, '<br>')}</p>` : ''}
      </li>`;
  }

  function renderReviews(p) {
    const box = byId('pd-reviews');
    if (!box) return;
    const cached = reviewsCache.get(p.id);
    if (!cached) { loadReviews(p); return; }
    let body;
    if (cached.status === 'loading') body = '<p class="note">Loading reviews…</p>';
    else if (cached.status === 'error') body = '<p class="note">Could not load reviews.</p>';
    else if (!cached.rows.length) body = '<p class="note">No reviews yet. Bought this? Rate it from My orders.</p>';
    else body = `<ul class="review-list">${cached.rows.map(reviewHtml).join('')}</ul>`;
    box.innerHTML = `
      <div class="reviews__head">
        <h2 class="reviews__title">Reviews</h2>
        ${p.ratingCount ? `<p class="rating rating--big">${starsHtml(p.ratingAvg)}<span>${p.ratingAvg.toFixed(1)} out of 5 &middot; ${p.ratingCount} ${plural(p.ratingCount, 'review', 'reviews')}</span></p>` : ''}
      </div>
      ${body}`;
  }

  productView.addEventListener('change', (event) => {
    if (!event.target.matches('input[name="pd-option"]')) return;
    const p = PRODUCT_BY_ID.get(view.slug);
    if (!p) return;
    page.option = Number(event.target.value);
    updatePurchase(p);
  });

  productView.addEventListener('click', (event) => {
    const p = PRODUCT_BY_ID.get(view.slug);
    if (!p) return;
    const thumb = event.target.closest('[data-pd-img]');
    if (thumb) {
      page.image = Number(thumb.dataset.pdImg);
      const main = byId('pd-main-img');
      if (main) main.src = photoUrl(p.images[page.image]);
      productView.querySelectorAll('[data-pd-img]').forEach((b) => b.setAttribute('aria-pressed', String(b === thumb)));
      return;
    }
    if (event.target.closest('[data-jump-reviews]')) {
      const box = byId('pd-reviews');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const del = event.target.closest('[data-delete-review]');
    if (del) {
      if (!window.confirm('Delete this review for everyone?')) return;
      del.disabled = true;
      sb.from('reviews').delete().eq('id', del.dataset.deleteReview).then(({ error }) => {
        if (error) { del.disabled = false; window.alert('Could not delete the review.'); return; }
        reviewsCache.delete(p.id);
        loadCatalog();
      });
      return;
    }
    if (event.target.closest('#pd-buy') && !purchaseState(p).disabled) startCheckout(p.id, page.option);
  });
  /* ---------- Checkout: log in first, then pay by PayPal or bank transfer ---------- */
  const PAYPAL_ON = !!CFG.paypalClientId;
  const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  const RECEIPT_MAX = 5 * 1024 * 1024;
  const checkout = { productId: '', option: null, method: '' };
  let paypalSdk = null;

  /* Works out a readable message from a Supabase function reply, whichever way it failed. */
  async function functionError(error, data) {
    if (data && data.error) return data.error;
    try {
      const body = await error.context.json();
      if (body && body.error) return body.error;
    } catch (e) { /* no readable body */ }
    return (error && error.message) || 'Something went wrong. Please try again.';
  }

  function loadPaypalSdk() {
    if (!paypalSdk) {
      paypalSdk = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(CFG.paypalClientId)}&currency=USD&intent=capture`;
        script.onload = () => resolve(window.paypal);
        script.onerror = () => { paypalSdk = null; reject(new Error('Could not load PayPal.')); };
        document.head.appendChild(script);
      });
    }
    return paypalSdk;
  }

  function checkoutFrame(p, inner) {
    const seller = sellerOf(p);
    byId('buy-body').innerHTML = `
      <button class="icon-btn dlg__x" type="button" data-close aria-label="Close">${icon('i-close')}</button>
      <div class="pay" style="--h:${hueOf(p)}">
        <p class="product__cat">Checkout</p>
        <h2 class="buy__title" id="buy-title">${esc(p.name)}</h2>
        <p class="product__seller">by ${esc(seller.name)}${offerOf(p, checkout.option).label ? ` &middot; ${esc(offerOf(p, checkout.option).label)}` : ''}</p>
        <p class="product__price buy__price">${priceHtml(p, checkout.option)}</p>
        ${inner}
      </div>`;
  }

  function showCheckoutMessage(p, title, text, primary) {
    checkoutFrame(p, `
      <div class="auth__done">
        <span class="auth__badge">${icon('i-check')}</span>
        <h3>${esc(title)}</h3>
        <p>${esc(text)}</p>
        ${primary || '<button class="btn btn--ink btn--block" type="button" data-close>Close</button>'}
      </div>`);
  }

  function startCheckout(id, optionIndex) {
    const p = PRODUCT_BY_ID.get(id);
    if (!p) return;
    checkout.productId = id;
    checkout.option = Number.isInteger(optionIndex) ? optionIndex : null;
    if (!buyDialog.open) buyDialog.showModal();
    if (!session) {
      showCheckoutMessage(p, 'Log in to buy', 'Your purchases and downloads are kept in your account. Log in with your email (no password needed), then come back to this product.',
        '<button class="btn btn--ink btn--block" type="button" data-login-first>Log in</button>');
      return;
    }
    /* Bank transfer goes to the seller's own account and is always the first choice; PayPal is optional. */
    renderPayStep(p, PAYPAL_ON && checkout.method === 'paypal' ? 'paypal' : 'bank');
  }

  /* Fills the bank transfer panel with the seller's own bank details and the payment form. */
  async function loadBankPanel(p) {
    const { data, error } = await sb.rpc('get_seller_bank', { p_seller_id: p.sellerId });
    const panel = byId('bank-panel');
    if (!panel || checkout.method !== 'bank' || checkout.productId !== p.id) return;
    const bank = Array.isArray(data) ? data[0] : null;
    if (error || !bank) {
      panel.innerHTML = `<p class="note">${esc(sellerOf(p).name)} has not added bank details yet, so this product cannot be paid for by bank transfer right now.${PAYPAL_ON ? ' You can use PayPal instead.' : ''}</p>`;
      return;
    }
    const rows = [['Bank', bank.bank_name], ['Account name', bank.account_name], ['Account number', bank.account_number], ['Branch', bank.branch]]
      .filter((row) => row[1])
      .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    panel.innerHTML = `
      <p class="auth__hint">Transfer <strong>${esc(CFG.currencySymbol)} ${rupeeNumber(offerOf(p, checkout.option).price)}</strong> to ${esc(sellerOf(p).name)}’s account below, then send the slip so they can confirm your payment.</p>
      <dl class="pay__bank">${rows}</dl>
      ${bank.note ? `<p class="auth__hint">${esc(bank.note)}</p>` : ''}
      <form class="auth__form" id="bank-form" novalidate>
        ${fieldHtml({ id: 'bank-reference', name: 'reference', label: 'Transfer reference or slip number', placeholder: 'For example the reference on your bank slip' })}
        <div class="field">
          <label for="bank-receipt">Photo or PDF of the slip (recommended)</label>
          <input id="bank-receipt" name="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" aria-describedby="bank-receipt-error">
          <p class="field__error" id="bank-receipt-error" hidden></p>
        </div>
        <p class="field__error" id="pay-error" hidden></p>
        <button class="btn btn--ink btn--block" type="submit">I have paid, send for review</button>
        ${legalNote('placing an order')}
      </form>`;
  }

  function renderPayStep(p, method) {
    checkout.method = method;
    const tabs = PAYPAL_ON ? `
      <div class="tabs" role="group" aria-label="Payment method">
        <button class="tab" type="button" data-pay-method="bank" aria-pressed="${method === 'bank'}">Bank transfer</button>
        <button class="tab" type="button" data-pay-method="paypal" aria-pressed="${method === 'paypal'}">PayPal</button>
      </div>` : '';
    let body;
    if (method === 'paypal') {
      body = `
        <p class="auth__hint">PayPal charges in US dollars: about ${esc(dollars(offerOf(p, checkout.option).price))} at today’s rate. The exact amount is shown by PayPal before you pay.</p>
        <p class="field__error" id="pay-error" hidden></p>
        <div id="paypal-buttons" class="pay__paypal"><p class="note">Loading PayPal…</p></div>`;
    } else {
      body = '<div id="bank-panel"><p class="note">Loading payment details…</p></div>';
    }
    checkoutFrame(p, `${tabs}${body}`);
    if (method === 'paypal') mountPaypal(p);
    else loadBankPanel(p);
  }

  async function mountPaypal(p) {
    const box = byId('paypal-buttons');
    const showError = (message) => { const e = byId('pay-error'); if (e) { e.textContent = message; e.hidden = false; } };
    try {
      const paypal = await loadPaypalSdk();
      if (checkout.method !== 'paypal' || !byId('paypal-buttons')) return;
      box.innerHTML = '';
      paypal.Buttons({
        style: { layout: 'vertical', shape: 'rect', label: 'pay' },
        createOrder: async () => {
          const { data, error } = await sb.functions.invoke('paypal-create-order', { body: { product_id: p.id, option: checkout.option } });
          if (error || !data || !data.id) throw new Error(await functionError(error, data));
          return data.id;
        },
        onApprove: async (approval) => {
          box.innerHTML = '<p class="note">Finishing your payment…</p>';
          const { data, error } = await sb.functions.invoke('paypal-capture', { body: { paypal_order_id: approval.orderID } });
          if (error || !data || !data.order_id) {
            box.innerHTML = '';
            showError(await functionError(error, data));
            return;
          }
          ordersState.status = 'idle';
          showCheckoutMessage(p, 'Payment received', 'Thank you! Your purchase is in your account.', '<a class="btn btn--ink btn--block" href="#/orders" data-close>View my orders</a>');
        },
        onError: (err) => showError((err && err.message) || 'PayPal could not complete the payment.')
      }).render('#paypal-buttons');
    } catch (err) {
      box.innerHTML = '';
      showError(err.message || 'Could not load PayPal.');
    }
  }

  async function submitBankOrder(form, p) {
    const reference = form.elements.reference.value.trim();
    const file = form.elements.receipt.files[0];
    const errorBox = byId('pay-error');
    errorBox.hidden = true;
    showFieldError(form.elements.reference, '');
    showFieldError(form.elements.receipt, '');
    let ok = true;
    if (reference.length < 3) { showFieldError(form.elements.reference, 'Enter the reference from your bank transfer.'); ok = false; }
    if (file && !RECEIPT_TYPES.includes(file.type)) { showFieldError(form.elements.receipt, 'Use a JPG, PNG, WebP or PDF file.'); ok = false; }
    else if (file && file.size > RECEIPT_MAX) { showFieldError(form.elements.receipt, 'That file is over 5 MB.'); ok = false; }
    if (!ok) return;

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Please wait…';
    try {
      let receiptPath = null;
      if (file) {
        const safeName = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').slice(-60);
        receiptPath = `${session.user.id}/${Date.now()}-${safeName}`;
        const { error: uploadError } = await sb.storage.from('receipts').upload(receiptPath, file, { contentType: file.type });
        if (uploadError) throw uploadError;
      }
      const { data: orderId, error } = await sb.rpc('create_bank_order', { p_product_id: p.id, p_option: checkout.option, p_reference: reference, p_receipt_path: receiptPath });
      if (error) throw error;
      loadCatalog(); /* the stock changed, so the shop shows the new numbers */
      /* Tell the owner (Telegram) there is a transfer to check. Failure here changes nothing for the customer. */
      sb.functions.invoke('notify', { body: { kind: 'bank_order', id: orderId } }).catch(() => {});
      ordersState.status = 'idle';
      showCheckoutMessage(p, 'Sent for review', 'The seller has been told and will check your transfer. Once they confirm it, your purchase appears under My orders.', '<a class="btn btn--ink btn--block" href="#/orders" data-close>View my orders</a>');
    } catch (err) {
      errorBox.textContent = (err && err.message) || 'Something went wrong. Please try again.';
      errorBox.hidden = false;
      if (/sold out|not available/i.test(errorBox.textContent)) loadCatalog();
      button.disabled = false;
      button.textContent = 'I have paid, send for review';
    }
  }

  buyDialog.addEventListener('click', (event) => {
    const method = event.target.closest('[data-pay-method]');
    if (method) {
      const p = PRODUCT_BY_ID.get(checkout.productId);
      if (p) renderPayStep(p, method.dataset.payMethod);
    }
  });

  buyDialog.addEventListener('submit', (event) => {
    event.preventDefault();
    const p = PRODUCT_BY_ID.get(checkout.productId);
    if (p && event.target.id === 'bank-form') submitBankOrder(event.target, p);
  });

  /* ---------- My orders (address: index.html#/orders) ---------- */
  const ORDER_STATUS = { awaiting_review: 'Waiting for review', paid: 'Paid', rejected: 'Not accepted' };

  let ordersTimer = 0;

  /* silent: refresh in the background without flashing the "Loading" message. */
  async function loadOrders(silent) {
    window.clearTimeout(ordersTimer);
    if (!session) return;
    if (!silent) {
      ordersState.status = 'loading';
      renderOrders();
    }
    const [{ data, error }, reviews] = await Promise.all([
      sb.from('orders').select('*').eq('customer_id', session.user.id).order('created_at', { ascending: false }),
      sb.from('reviews').select('*').eq('customer_id', session.user.id)
    ]);
    if (!session) return;
    ordersState.status = error ? 'error' : 'ready';
    ordersState.rows = data || [];
    ordersState.reviews = new Map(((reviews && reviews.data) || []).map((r) => [r.order_id, r]));
    /* Do not wipe a review someone is in the middle of writing. */
    if (!(silent && ordersView.querySelector('form[data-dirty]'))) renderOrders();
    /* While a transfer is waiting for the seller, look again every 20 seconds so approval shows up by itself. */
    if (view.name === 'orders' && ordersState.rows.some((o) => o.status === 'awaiting_review' || (o.status === 'paid' && o.is_vpn && !o.delivery))) {
      ordersTimer = window.setTimeout(() => loadOrders(true), 20000);
    }
  }

  /* The "Rate this purchase" part of a paid order: the saved review, or a form to write or change it. */
  function orderReviewHtml(o) {
    if (o.status !== 'paid' || !o.product_id) return '';
    const r = ordersState.reviews.get(o.id);
    if (r && !ordersState.editing.has(o.id)) {
      return `
        <div class="order__review">
          <p class="order__label">Your review</p>
          ${starsHtml(r.rating)}
          ${r.comment ? `<p class="review__text">${esc(r.comment).replace(/\n/g, '<br>')}</p>` : ''}
          <button class="link" type="button" data-edit-review="${esc(o.id)}">Edit review</button>
        </div>`;
    }
    const current = r ? r.rating : 0;
    const stars = [5, 4, 3, 2, 1].map((n) => `
      <input type="radio" name="rating" id="rate-${esc(o.id)}-${n}" value="${n}" ${current === n ? 'checked' : ''}>
      <label for="rate-${esc(o.id)}-${n}" title="${n} ${plural(n, 'star', 'stars')}">${icon('i-star')}<span class="sr-only">${n} ${plural(n, 'star', 'stars')}</span></label>`).join('');
    return `
      <form class="order__review review-form" data-review-order="${esc(o.id)}" novalidate>
        <p class="order__label">${r ? 'Edit your review' : 'Rate this purchase'}</p>
        <fieldset class="star-input"><legend class="sr-only">Your rating</legend>${stars}</fieldset>
        <textarea name="comment" rows="3" maxlength="500" placeholder="Write a comment (optional)">${esc(r ? r.comment : '')}</textarea>
        <p class="review-form__note note" hidden></p>
        <div class="review-form__actions">
          <button class="btn btn--ink btn--sm" type="submit">${r ? 'Save review' : 'Post review'}</button>
          ${r ? `<button class="link" type="button" data-cancel-review="${esc(o.id)}">Cancel</button>` : ''}
        </div>
      </form>`;
  }

  function orderCard(o) {
    let detail = '';
    if (o.status === 'paid') {
      if (o.delivery) {
        const link = (o.delivery.match(/^(?:vless|vmess|trojan):\/\/\S+$/m) || [''])[0];
        const copy = link ? `<button class="btn btn--ink btn--sm order__copy" type="button" data-copy-link="${esc(link)}">Copy connection link</button>` : '';
        detail = `<div class="order__delivery"><p class="order__label">Your purchase</p><pre>${esc(o.delivery)}</pre>${copy}</div>`;
      }
      else if (o.is_vpn) detail = '<p class="note">Your VPN access is being set up. Check back in a few minutes; if it does not appear, contact the seller.</p>';
      else detail = '<p class="note">Payment confirmed. The seller has not added download details yet, so please contact them.</p>';
    } else if (o.status === 'awaiting_review') {
      detail = '<p class="note">The seller is checking your bank transfer. This page updates by itself once it is confirmed.</p>';
    } else {
      detail = '<p class="note">The seller could not confirm this payment. If you already paid, please contact the seller with your transfer slip.</p>';
    }
    const price = o.method === 'paypal' && o.amount_usd ? `$${money2(Number(o.amount_usd))} via PayPal` : `${esc(CFG.currencySymbol)} ${rupeeNumber(o.amount_lkr)} by bank transfer`;
    return `
      <article class="order">
        <div class="order__head">
          <h3 class="order__name">${esc(o.product_name)}</h3>
          <span class="order__status order__status--${esc(o.status)}">${esc(ORDER_STATUS[o.status] || o.status)}</span>
        </div>
        <p class="order__meta">${price} &middot; ${esc(formatDate(o.created_at.slice(0, 10)))}</p>
        ${detail}
        ${orderReviewHtml(o)}
      </article>`;
  }

  function renderOrders() {
    let inner;
    if (!session) {
      inner = `
        <div class="empty">
          <p class="empty__title">Log in to see your orders</p>
          <p>Your purchases and downloads are kept in your account.</p>
          <button class="btn btn--ink" type="button" data-login-first>Log in</button>
        </div>`;
    } else {
      if (ordersState.status === 'idle') { loadOrders(); return; }
      if (ordersState.status === 'loading') inner = '<p class="note">Loading your orders…</p>';
      else if (ordersState.status === 'error') inner = '<p class="note">Could not load your orders. Please refresh the page.</p>';
      else if (!ordersState.rows.length) inner = '<div class="empty"><p class="empty__title">No orders yet</p><p>When you buy something it shows up here.</p><a class="btn btn--ink" href="#/">Browse products</a></div>';
      else inner = `<div class="orders">${ordersState.rows.map(orderCard).join('')}</div>`;
    }
    ordersView.innerHTML = `
      <section class="sec tone tone--paper" aria-labelledby="orders-title">
        <div class="wrap">
          <a class="back" href="#/">${icon('i-back')}<span>All products</span></a>
          <header class="sec__head"><h1 class="h2" id="orders-title">My orders</h1></header>
          ${inner}
        </div>
      </section>`;
  }

  ordersView.addEventListener('input', (event) => {
    const form = event.target.closest('form[data-review-order]');
    if (form) form.dataset.dirty = '1';
  });

  ordersView.addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit-review]');
    if (edit) { ordersState.editing.add(edit.dataset.editReview); renderOrders(); return; }
    const cancel = event.target.closest('[data-cancel-review]');
    if (cancel) { ordersState.editing.delete(cancel.dataset.cancelReview); renderOrders(); }
  });

  ordersView.addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-review-order]');
    if (!form) return;
    event.preventDefault();
    const note = form.querySelector('.review-form__note');
    const button = form.querySelector('button[type="submit"]');
    const checked = form.querySelector('input[name="rating"]:checked');
    const say = (text) => { note.textContent = text; note.hidden = !text; };
    if (!checked) { say('Choose 1 to 5 stars.'); return; }
    say('');
    button.disabled = true;
    const orderId = form.dataset.reviewOrder;
    const { error } = await sb.rpc('submit_review', { p_order_id: orderId, p_rating: Number(checked.value), p_comment: form.elements.comment.value });
    button.disabled = false;
    if (error) { say(error.message || 'Could not save your review. Please try again.'); return; }
    ordersState.editing.delete(orderId);
    const order = ordersState.rows.find((o) => o.id === orderId);
    if (order) reviewsCache.delete(order.product_id);
    await loadOrders(true);
    renderOrders();
    loadCatalog(); /* refresh the star averages */
  });

  /* A click on the dark backdrop closes the dialog. Page scrolling is locked in CSS while a dialog is open. */
  buyDialog.addEventListener('click', (event) => {
    if (event.target === buyDialog) buyDialog.close();
  });

  /* ---------- Log in and sign up (a preview: nothing is sent or saved yet) ----------
     Customers log in with an email link (no password). Sellers use email and password.
     Nothing typed here leaves the page; real accounts arrive when the back end is connected. */
  const authDialog = byId('auth');
  const auth = { role: 'customer', mode: 'login' };
  const ROLES = {
    customer: { label: 'Customer', icon: 'i-bag', hue: 226 },
    seller: { label: 'Seller', icon: 'i-store', hue: 160 }
  };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');

  /* A short line under a submit button that links to the Terms and the Privacy Policy. */
  function legalNote(action) {
    return `<p class="legal-note">By ${action} you agree to our <a href="terms.html" target="_blank" rel="noopener">Terms of Service</a> and <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</p>`;
  }

  function fieldHtml({ id, name, label, type = 'text', autocomplete = 'off', placeholder = '' }) {
    return `
      <div class="field">
        <label for="${id}">${label}</label>
        <input id="${id}" name="${name}" type="${type}" autocomplete="${autocomplete}" placeholder="${esc(placeholder)}" aria-describedby="${id}-error">
        <p class="field__error" id="${id}-error" hidden></p>
      </div>`;
  }

  function passwordHtml(autocomplete, hint) {
    return `
      <div class="field">
        <label for="auth-password">Password</label>
        <div class="pw">
          <input id="auth-password" name="password" type="password" autocomplete="${autocomplete}" aria-describedby="auth-password-error">
          <button class="pw__toggle" type="button" data-pw-toggle="auth-password" aria-pressed="false">Show</button>
        </div>
        ${hint ? `<p class="field__hint">${hint}</p>` : ''}
        <p class="field__error" id="auth-password-error" hidden></p>
      </div>`;
  }

  function authFormHtml() {
    const email = fieldHtml({ id: 'auth-email', name: 'email', label: 'Email', type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });

    if (auth.role === 'customer') {
      const google = CFG.googleLogin ? `
        <button class="btn btn--ghost btn--block" type="button" data-google-login>
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.2z" fill="#4285F4" stroke="none"/><path d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" fill="#34A853" stroke="none"/><path d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2z" fill="#FBBC05" stroke="none"/><path d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1z" fill="#EA4335" stroke="none"/></svg>
          <span>Continue with Google</span>
        </button>
        <p class="auth__or"><span>or use your email</span></p>` : '';
      return `
        ${google}
        <form class="auth__form" id="auth-form" novalidate>
          ${email}
          <button class="btn btn--ink btn--block" type="submit">Email me a log in link</button>
          ${legalNote('logging in')}
        </form>`;
    }
    if (auth.mode === 'signup') {
      return `
        <form class="auth__form" id="auth-form" novalidate>
          ${fieldHtml({ id: 'auth-store-name', name: 'storeName', label: 'Store name', autocomplete: 'organization', placeholder: 'Your store name' })}
          <div class="field">
            <label for="auth-store-address">Store address</label>
            <div class="addr">
              <span class="addr__prefix" aria-hidden="true">/store/</span>
              <input id="auth-store-address" name="storeAddress" type="text" autocomplete="off" spellcheck="false" aria-describedby="auth-store-address-error">
            </div>
            <p class="field__hint">Letters, numbers and hyphens. This is your store's web address.</p>
            <p class="field__error" id="auth-store-address-error" hidden></p>
          </div>
          ${email}
          ${passwordHtml('new-password', 'At least 8 characters.')}
          <p class="auth__hint">Your store is reviewed before it goes live. After approval, the store fee is ${esc(CFG.currencySymbol)} ${rupeeNumber(CFG.sellerMonthlyFee)} per month.</p>
          <button class="btn btn--ink btn--block" type="submit">Create seller account</button>
          ${legalNote('creating an account')}
        </form>`;
    }
    if (auth.mode === 'forgot') {
      return `
        <form class="auth__form" id="auth-form" novalidate>
          ${email}
          <button class="btn btn--ink btn--block" type="submit">Send reset link</button>
          <p class="auth__hint"><button class="link" type="button" data-auth-mode="login">Back to log in</button></p>
        </form>`;
    }
    return `
      <form class="auth__form" id="auth-form" novalidate>
        ${email}
        ${passwordHtml('current-password', '')}
        <p class="auth__row"><button class="link" type="button" data-auth-mode="forgot">Forgot your password?</button></p>
        <button class="btn btn--ink btn--block" type="submit">Log in</button>
      </form>`;
  }

  function renderAuth() {
    const role = ROLES[auth.role];
    const isSeller = auth.role === 'seller';
    const titles = { login: isSeller ? 'Welcome back' : 'Log in or sign up', signup: 'Create your store', forgot: 'Reset your password' };
    const subs = {
      'customer:login': 'Enter your email and we’ll send a one-time link. No password needed — the same link creates your account the first time.',
      'seller:login': 'Log in to manage your store, your products and your orders.',
      'seller:signup': 'Set up your shop in a minute. We’ll review it before it goes live.',
      'seller:forgot': 'Enter your email and we’ll send you a link to reset your password.'
    };
    const tabs = isSeller && auth.mode !== 'forgot' ? `
      <div class="tabs" role="group" aria-label="Seller account">
        <button class="tab" type="button" data-auth-mode="login" aria-pressed="${auth.mode === 'login'}">Log in</button>
        <button class="tab" type="button" data-auth-mode="signup" aria-pressed="${auth.mode === 'signup'}">Sign up</button>
      </div>` : '';
    byId('auth-body').innerHTML = `
      <div class="auth">
        <button class="icon-btn dlg__x" type="button" data-close aria-label="Close">${icon('i-close')}</button>
        <div class="auth__head" style="--h:${role.hue}">
          <span class="auth__icon">${icon(role.icon)}</span>
          <div>
            <p class="eyebrow">${role.label}</p>
            <h2 class="auth__title" id="auth-title">${titles[auth.mode]}</h2>
            <p class="auth__sub">${esc(subs[`${auth.role}:${auth.mode}`] || '')}</p>
          </div>
        </div>
        ${tabs}
        <p class="field__error" id="auth-form-error" hidden></p>
        <div id="auth-panel">${authFormHtml()}</div>
        <p class="auth__switch">${isSeller ? 'Buying instead?' : 'Selling your own products?'}
          <button class="link" type="button" data-auth-role="${isSeller ? 'customer' : 'seller'}">${isSeller ? 'Log in as a customer' : 'Log in as a seller'}</button>
        </p>
      </div>`;
  }

  function focusFirstField() {
    const field = authDialog.querySelector('#auth-panel input');
    if (field) field.focus();
  }

  function openAuth(role, mode) {
    auth.role = role;
    auth.mode = role === 'customer' ? 'login' : (mode || 'login');
    renderAuth();
    if (!authDialog.open) authDialog.showModal();
    focusFirstField();
  }

  function showFieldError(input, message) {
    const error = byId(`${input.id}-error`);
    if (!error) return;
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    error.textContent = message || '';
    error.hidden = !message;
  }

  /* Returns a list of [input, message] for everything that is wrong in the form, before we ask the server. */
  function checkAuth(form) {
    const f = form.elements;
    const problems = [];
    if (!EMAIL_RE.test(f.email.value.trim())) problems.push([f.email, 'Enter a valid email address.']);
    if (auth.role === 'seller' && auth.mode === 'signup') {
      const storeName = f.storeName.value.trim();
      const address = f.storeAddress.value.trim();
      if (storeName.length < 3 || storeName.length > 40) problems.push([f.storeName, 'Enter a store name of 3 to 40 characters.']);
      if (address.length < 3 || address.length > 30 || !SLUG_RE.test(address)) problems.push([f.storeAddress, 'Use 3 to 30 lowercase letters, numbers or hyphens.']);
      if (f.password.value.length < 8) problems.push([f.password, 'Use at least 8 characters.']);
    }
    if (auth.role === 'seller' && auth.mode === 'login' && !f.password.value) problems.push([f.password, 'Enter your password.']);
    return problems;
  }

  function showAuthNote(message) {
    const note = byId('auth-form-error');
    if (note) { note.textContent = message; note.hidden = !message; }
  }

  /* Turns a Supabase error into a short, plain-English message. */
  function friendlyAuthError(err) {
    const msg = (err && err.message) || '';
    if (/invalid login credentials/i.test(msg)) return 'That email and password do not match. Check them and try again.';
    if (/already registered|already exists/i.test(msg)) return 'An account with that email already exists. Try logging in instead.';
    if (/email not confirmed/i.test(msg)) return 'Please confirm your email first, then log in. Check your inbox for the confirmation link.';
    if (/rate limit/i.test(msg)) return 'Too many attempts. Please wait a minute and try again.';
    return msg || 'Something went wrong. Please try again.';
  }

  function showAuthDone(needsConfirm) {
    const messages = {
      'customer:login': 'Check your email for a one-time log in link. Open it on this device to finish logging in. First time here? The same link creates your account.',
      'seller:signup': needsConfirm
        ? 'Check your email and confirm your account. After confirming, log in from the Seller tab. Your store still needs to be approved before it goes live.'
        : 'Your seller account is ready. Your store still needs to be approved before it goes live.',
      'seller:forgot': 'Check your email for a password reset link.'
    };
    byId('auth-panel').innerHTML = `
      <div class="auth__done">
        <span class="auth__badge">${icon('i-check')}</span>
        <h3>Almost done</h3>
        <p>${messages[`${auth.role}:${auth.mode}`]}</p>
        <button class="btn btn--ink btn--block" type="button" data-close>Close</button>
      </div>`;
  }

  authDialog.addEventListener('click', (event) => {
    if (event.target === authDialog) { authDialog.close(); return; }
    const modeButton = event.target.closest('[data-auth-mode]');
    if (modeButton) {
      auth.mode = modeButton.dataset.authMode;
      renderAuth();
      focusFirstField();
      return;
    }
    const roleButton = event.target.closest('[data-auth-role]');
    if (roleButton) {
      auth.role = roleButton.dataset.authRole;
      auth.mode = 'login';
      renderAuth();
      focusFirstField();
      return;
    }
    if (event.target.closest('[data-google-login]')) {
      sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectUrl() } }).then(({ error }) => {
        if (error) showAuthNote(friendlyAuthError(error));
      });
      return;
    }
    const toggle = event.target.closest('[data-pw-toggle]');
    if (toggle) {
      const input = byId(toggle.dataset.pwToggle);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Hide' : 'Show';
      toggle.setAttribute('aria-pressed', String(show));
    }
  });

  authDialog.addEventListener('input', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.getAttribute('aria-invalid') === 'true') showFieldError(input, '');
    if (input.name === 'storeName') {
      const address = authDialog.querySelector('[name="storeAddress"]');
      if (address && !address.dataset.touched) address.value = slugify(input.value);
    }
    if (input.name === 'storeAddress') input.dataset.touched = '1';
  });

  authDialog.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const submitButton = form.querySelector('button[type="submit"]');
    Array.from(form.elements).filter((el) => el instanceof HTMLInputElement).forEach((el) => showFieldError(el, ''));
    showAuthNote('');

    const problems = checkAuth(form);
    problems.forEach(([input, message]) => showFieldError(input, message));
    if (problems.length) {
      problems[0][0].focus();
      return;
    }

    const email = form.elements.email.value.trim();
    submitButton.disabled = true;
    const originalLabel = submitButton.textContent;
    submitButton.textContent = 'Please wait…';

    try {
      if (auth.role === 'customer') {
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectUrl() } });
        if (error) throw error;
        showAuthDone(false);
      } else if (auth.mode === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email, password: form.elements.password.value });
        if (error) throw error;
        /* Success closes the dialog itself, from the auth state change listener. */
      } else if (auth.mode === 'signup') {
        const storeName = form.elements.storeName.value.trim();
        const storeSlug = form.elements.storeAddress.value.trim();
        const password = form.elements.password.value;

        const { data: taken, error: takenError } = await sb.rpc('slug_taken', { slug: storeSlug });
        if (takenError) throw takenError;
        if (taken) {
          showFieldError(form.elements.storeAddress, 'That store address is already used.');
          form.elements.storeAddress.focus();
          return;
        }

        /* The store details travel inside the new account (user_metadata). ensureProfile() reads
           them the moment a session exists, whether that is right now or after the email is
           confirmed later, even on another device. */
        const hue = Math.floor(Math.random() * 360);
        const { data: signUpData, error } = await sb.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: redirectUrl(),
            data: { signup_role: 'seller', store_name: storeName, store_slug: storeSlug, hue }
          }
        });
        if (error) throw error;
        showAuthDone(!signUpData.session);
      } else if (auth.mode === 'forgot') {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
        if (error) throw error;
        showAuthDone(false);
      }
    } catch (err) {
      showAuthNote(friendlyAuthError(err));
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalLabel;
    }
  });

  /* ---------- Clicks that belong to the whole page ---------- */
  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    const copyButton = target.closest('[data-copy-link]');
    if (copyButton) {
      const done = () => { copyButton.textContent = 'Copied'; window.setTimeout(() => { copyButton.textContent = 'Copy connection link'; }, 2000); };
      if (navigator.clipboard) navigator.clipboard.writeText(copyButton.dataset.copyLink).then(done, () => { copyButton.textContent = 'Select the link above and copy it'; });
      else copyButton.textContent = 'Select the link above and copy it';
      return;
    }
    if (target.closest('[data-login-first]')) {
      if (buyDialog.open) buyDialog.close();
      openAuth('customer', 'login');
      return;
    }
    const close = target.closest('[data-close]');
    if (close) { close.closest('dialog').close(); return; }

    /* "Back to top" should not change the address; the logo goes to the home page. */
    if (target.closest('a[href="#top"]')) { event.preventDefault(); scrollToTop(); return; }
    if (target.closest('a.brand') && (window.location.hash === '' || window.location.hash === '#/')) {
      event.preventDefault();
      scrollToTop();
    }
  });

  /* ---------- Start ---------- */
  byId('year').textContent = String(new Date().getFullYear());
  paintThemeButton();
  renderChips();
  route();
  renderRateNote();
  loadRate();
  loadCatalog();
})();



