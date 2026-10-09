/* Quartz Eon: the seller's product panel. Everything about the products in one place: the title, description,
   photos, price, options (each with its own price and stock), stock, "show how many are left" and "sold out".
   Log in on seller.html first; this page sends anyone who is not a logged in seller there. */
(function () {
  'use strict';

  const CFG = Object.assign({ storeName: 'Quartz Eon', categories: [] }, window.QE_CONFIG);
  const sb = window.QE_SUPABASE;
  const root = document.documentElement;
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const BUCKET = 'product-images';
  const MAX_PHOTOS = 6;
  const MAX_OPTIONS = 12;

  const byId = (id) => document.getElementById(id);
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  const icon = (id) => `<svg class="i" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
  const art = (name) => `<svg class="art" aria-hidden="true" focusable="false"><use href="#a-${esc(name)}"/></svg>`;
  const plural = (n, one, many) => (n === 1 ? one : many);
  const rupees = (n) => `Rs. ${Math.round(Number(n)).toLocaleString('en-US')}`;
  const storage = { set(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } } };
  const photoUrl = (path) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  /* A logo is either an uploaded file (a storage path) or one picked from the brand library, saved as "si:<name>". */
  const LIB = 'si:';
  const isFile = (value) => !!value && !String(value).startsWith(LIB) && !String(value).startsWith('brands/'); // shared brand logos belong to the owner, never deleted by a seller
  const logoUrl = (value) => (String(value).startsWith(LIB) ? ('https://cdn.simpleicons.org/' + encodeURIComponent(String(value).slice(LIB.length))) : photoUrl(value));

  /* ---------- Theme ---------- */
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
  }
  themeButton.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    storage.set('quartz-eon.theme', next);
    paintThemeButton();
  });
  darkQuery.addEventListener('change', paintThemeButton);
  paintThemeButton();

  /* ---------- Toasts and small helpers ---------- */
  let toastTimer = 0;
  function toast(message) {
    const box = byId('seller-toasts');
    box.innerHTML = `<div class="toast"><span>${esc(message)}</span></div>`;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { box.innerHTML = ''; }, 3600);
  }

  function showFieldError(input, message) {
    const error = byId(`${input.id}-error`);
    if (!error) return;
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    error.textContent = message || '';
    error.hidden = !message;
  }

  function showBox(id, message) {
    const box = byId(id);
    box.textContent = message || '';
    box.hidden = !message;
  }

  /* Whole number from a text box, or null when it is empty, or NaN when it is not a number. */
  function readInt(value) {
    const text = String(value == null ? '' : value).trim();
    if (text === '') return null;
    const n = Number(text);
    return Number.isInteger(n) ? n : NaN;
  }

  /* ---------- Who is here ---------- */
  let sellerRow = null;
  let products = [];

  byId('pp-logout').addEventListener('click', () => sb.auth.signOut());
  sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') window.location.replace('seller.html'); });

  async function start() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { window.location.replace('seller.html'); return; }
    byId('pp-logout').hidden = false;
    const { data: profile } = await sb.from('profiles').select('role').eq('id', session.user.id).maybeSingle();
    const { data: row } = profile && profile.role === 'seller'
      ? await sb.from('sellers').select('*').eq('id', session.user.id).maybeSingle()
      : { data: null };
    byId('pp-loading').hidden = true;
    if (!row) { byId('pp-denied').hidden = false; return; }
    sellerRow = row;
    byId('pp-app').hidden = false;
    fillCategories();
    loadProducts();
    checkPanel();
    /* "Add a new product" on the seller's store page links here as products.html#new. */
    if (window.location.hash === '#new') {
      history.replaceState(null, '', window.location.pathname);
      openEditor(null);
    }
  }

  function fillCategories() {
    const names = CFG.categories.length ? CFG.categories : ['Templates', 'E-books', 'Courses', 'Software', 'Design assets'];
    byId('pp-category').innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  }

  /* ---------- The list ---------- */
  function isSoldOut(p) {
    if (p.sold_out) return true;
    const options = Array.isArray(p.options) ? p.options : [];
    if (options.length) return options.every((o) => o.stock != null && Number(o.stock) <= 0);
    return p.stock != null && Number(p.stock) <= 0;
  }

  async function loadProducts() {
    const { data, error } = await sb.from('products').select('*').eq('seller_id', sellerRow.id).order('created_at', { ascending: false });
    if (error) { toast(`Could not load products: ${error.message}`); return; }
    products = data || [];
    renderList();
  }

  function stockLine(p) {
    const options = Array.isArray(p.options) ? p.options : [];
    if (options.length) {
      const out = options.filter((o) => o.stock != null && Number(o.stock) <= 0).length;
      return `${options.length} ${plural(options.length, 'option', 'options')}${out ? `, ${out} sold out` : ''}`;
    }
    return p.stock == null ? 'Unlimited stock' : `${p.stock} in stock`;
  }

  function productRow(p) {
    const cover = p.theme === 'plan' && p.logo ? logoUrl(p.logo) : (Array.isArray(p.images) && p.images.length ? photoUrl(p.images[0]) : '');
    const options = Array.isArray(p.options) ? p.options : [];
    const sold = isSoldOut(p);
    const badges = [
      p.status === 'hidden' ? '<span class="status-badge status-badge--suspended">Hidden</span>' : '',
      sold ? '<span class="status-badge status-badge--suspended">Sold out</span>' : ''
    ].join(' ');
    const price = options.length ? `From ${rupees(p.price)}` : rupees(p.price);
    return `
      <article class="prod-row pp-row" style="--h:${Number(sellerRow.hue) || 0}">
        <div class="prod-row__main">
          <span class="prod-row__art pp-thumb">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : art(p.icon)}</span>
          <div class="prod-row__text">
            <p class="prod-row__name">${esc(p.name)} ${badges}</p>
            <p class="prod-row__meta">${esc(p.category)} &middot; ${esc(price)} &middot; ${esc(stockLine(p))}</p>
          </div>
        </div>
        <div class="prod-row__actions">
          <button class="btn btn--ghost btn--sm" type="button" data-toggle-sold="${esc(p.id)}">${p.sold_out ? 'Back in stock' : 'Mark sold out'}</button>
          <button class="icon-btn icon-btn--sm" type="button" data-edit="${esc(p.id)}" aria-label="Edit ${esc(p.name)}">${icon('i-edit')}</button>
          <button class="icon-btn icon-btn--sm icon-btn--danger" type="button" data-delete="${esc(p.id)}" aria-label="Delete ${esc(p.name)}">${icon('i-trash')}</button>
        </div>
      </article>`;
  }

  function renderList() {
    byId('pp-list').innerHTML = products.map(productRow).join('');
    byId('pp-list').hidden = products.length === 0;
    byId('pp-empty').hidden = products.length > 0;
    byId('pp-count').textContent = `${products.length} ${plural(products.length, 'product', 'products')}`;
  }

  byId('pp-list').addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit]');
    if (edit) { openEditor(products.find((p) => p.id === edit.dataset.edit)); return; }
    const del = event.target.closest('[data-delete]');
    if (del) {
      const p = products.find((row) => row.id === del.dataset.delete);
      if (p && window.confirm(`Delete "${p.name}"? This cannot be undone.`)) deleteProduct(p);
      return;
    }
    const sold = event.target.closest('[data-toggle-sold]');
    if (sold) {
      const p = products.find((row) => row.id === sold.dataset.toggleSold);
      if (!p) return;
      const { error } = await sb.from('products').update({ sold_out: !p.sold_out }).eq('id', p.id);
      if (error) { toast(`Could not update: ${error.message}`); return; }
      p.sold_out = !p.sold_out;
      renderList();
      toast(p.sold_out ? 'Marked as sold out' : 'Back in stock');
    }
  });

  async function deleteProduct(p) {
    const { error } = await sb.from('products').delete().eq('id', p.id);
    if (error) { toast(`Could not delete: ${error.message}`); return; }
    const files = (Array.isArray(p.images) ? p.images : []).concat(isFile(p.logo) ? [p.logo] : []);
    if (files.length) sb.storage.from(BUCKET).remove(files).catch(() => {});
    products = products.filter((row) => row.id !== p.id);
    renderList();
    toast('Product deleted');
  }

  /* ---------- The editor ---------- */
  const form = byId('pp-form');
  let images = [];          // photo paths in the storage bucket, the first is the cover
  let originalImages = [];  // what was saved before this edit, to clean up removed photos
  let opts = [];            // option rows: { label, price, stock, days, gb } as text from the boxes
  let uploading = 0;
  let logo = '';            // the plan card's logo path
  let originalLogo = '';
  let stats = [];          // plan card key figures: { value, label }
  let info = [];           // plan card detail lines: { icon, text }
  const ICONS = [['bolt', 'Lightning'], ['server', 'Server'], ['info', 'Info'], ['shield', 'Shield'], ['clock', 'Clock'], ['check', 'Tick'], ['star', 'Star'], ['globe', 'Globe'], ['gift', 'Gift']];
  const theme = () => (form.elements.theme.value === 'plan' ? 'plan' : 'standard');

  const isVpn = () => form.elements.icon.value === 'vpn';

  /* ---------- VPN client settings (used when a client is created on the seller's panel) ---------- */
  let hasPanel = null; // whether the seller saved their panel connection; null until known

  async function checkPanel() {
    const { data } = await sb.from('seller_vpn_config').select('seller_id').eq('seller_id', sellerRow.id).maybeSingle();
    hasPanel = !!data;
    if (!byId('pp-editor-view').hidden) syncSections();
  }

  function fillVpnSettings(raw) {
    const v = raw && typeof raw === 'object' ? raw : {};
    const f = form.elements;
    f.vpnInbound.value = v.inbound_id || '';
    f.vpnFlow.value = ['xtls-rprx-vision', 'xtls-rprx-vision-udp443'].includes(v.flow) ? v.flow : '';
    f.vpnLimitIp.value = v.limit_ip || 0;
    f.vpnPrefix.value = v.prefix || '';
    f.vpnFirstUse.checked = !!v.start_on_first_use;
    f.vpnSni.value = v.sni || '';
    f.vpnHost.value = v.host || '';
    f.vpnAddress.value = v.address || '';
    f.vpnPort.value = v.port || '';
    f.vpnRemark.value = v.remark || '';
    f.vpnNote.value = v.note || '';
  }

  /* Reads and checks the VPN client boxes. Returns the settings object, or null when something is wrong. */
  function readVpnSettings() {
    const f = form.elements;
    let ok = true;
    const hostLike = /^[A-Za-z0-9.-]*$/;
    const inbound = readInt(f.vpnInbound.value);
    if (Number.isNaN(inbound) || (inbound != null && inbound < 1)) { showFieldError(f.vpnInbound, 'Enter the inbound number, or leave it empty.'); ok = false; }
    const limitIp = readInt(f.vpnLimitIp.value);
    if (Number.isNaN(limitIp) || (limitIp != null && (limitIp < 0 || limitIp > 100))) { showFieldError(f.vpnLimitIp, 'Enter 0 to 100.'); ok = false; }
    const prefix = f.vpnPrefix.value.trim();
    if (!/^[A-Za-z0-9_-]*$/.test(prefix)) { showFieldError(f.vpnPrefix, 'Use only letters, numbers, - and _.'); ok = false; }
    const sni = f.vpnSni.value.trim();
    if (!hostLike.test(sni)) { showFieldError(f.vpnSni, 'Enter a host name like www.example.com.'); ok = false; }
    const host = f.vpnHost.value.trim();
    if (!/^[A-Za-z0-9.,-]*$/.test(host)) { showFieldError(f.vpnHost, 'Enter a host name like www.example.com.'); ok = false; }
    const address = f.vpnAddress.value.trim();
    if (!/^[A-Za-z0-9.:\[\]-]*$/.test(address)) { showFieldError(f.vpnAddress, 'Enter a host name or IP address only (no http://).'); ok = false; }
    const port = readInt(f.vpnPort.value);
    if (Number.isNaN(port) || (port != null && (port < 1 || port > 65535))) { showFieldError(f.vpnPort, 'Enter a port from 1 to 65535.'); ok = false; }
    if (!ok) return null;
    return {
      inbound_id: inbound || null,
      flow: f.vpnFlow.value,
      limit_ip: limitIp || 0,
      prefix,
      start_on_first_use: f.vpnFirstUse.checked,
      sni,
      host,
      address,
      port: port || null,
      remark: f.vpnRemark.value.trim().slice(0, 40),
      note: f.vpnNote.value.trim().slice(0, 500)
    };
  }

  function openEditor(p) {
    const editing = !!p;
    form.reset();
    Array.from(form.querySelectorAll('[aria-invalid]')).forEach((el) => showFieldError(el, ''));
    showBox('pp-form-error', '');
    showBox('pp-photo-error', '');
    showBox('pp-options-error', '');
    form.elements.productId.value = editing ? p.id : '';
    byId('pp-editor-eyebrow').textContent = editing ? 'Editing' : 'New product';
    byId('pp-editor-title').textContent = editing ? p.name : 'Add a product';
    if (editing) {
      form.elements.name.value = p.name;
      form.elements.description.value = p.description || '';
      form.elements.category.value = p.category;
      form.elements.icon.value = p.icon;
      form.elements.type.value = p.type || '';
      form.elements.price.value = p.price;
      form.elements.stock.value = p.stock == null ? '' : p.stock;
      form.elements.vpnDays.value = p.vpn_days || 30;
      form.elements.vpnGb.value = p.vpn_data_gb || 0;
      form.elements.deliveryInfo.value = p.delivery_info || '';
      fillVpnSettings(p.vpn_settings);
      form.elements.showStock.checked = !!p.show_stock;
      form.elements.soldOut.checked = !!p.sold_out;
      form.elements.hidden.checked = p.status === 'hidden';
      form.elements.theme.value = p.theme === 'plan' ? 'plan' : 'standard';
      form.elements.badge.value = p.badge || '';
      logo = p.logo || '';
      stats = (Array.isArray(p.stats) ? p.stats : []).map((s) => ({ value: s.value || '', label: s.label || '' }));
      info = (Array.isArray(p.info) ? p.info : []).map((i) => ({ icon: i.icon || 'info', text: i.text || '' }));
      images = Array.isArray(p.images) ? p.images.slice() : [];
      opts = (Array.isArray(p.options) ? p.options : []).map((o) => ({
        label: o.label || '', price: o.price == null ? '' : String(o.price), stock: o.stock == null ? '' : String(o.stock),
        days: o.days == null ? '' : String(o.days), gb: o.gb == null ? '' : String(o.gb)
      }));
    } else {
      images = [];
      opts = [];
      logo = '';
      stats = [];
      info = [];
    }
    originalImages = images.slice();
    originalLogo = logo;
    showBox('pp-plan-error', '');
    showBox('pp-logo-error', '');
    renderLogo();
    renderStats();
    renderInfo();
    renderPhotos();
    renderOptions();
    syncSections();
    byId('pp-list-view').hidden = true;
    byId('pp-editor-view').hidden = false;
    window.scrollTo({ top: 0, behavior: 'instant' });
    form.elements.name.focus();
  }

  function closeEditor() {
    byId('pp-editor-view').hidden = true;
    byId('pp-list-view').hidden = false;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  byId('pp-add').addEventListener('click', () => openEditor(null));
  byId('pp-cancel').addEventListener('click', () => { discardNewPhotos(); closeEditor(); });
  byId('pp-cancel-top').addEventListener('click', () => { discardNewPhotos(); closeEditor(); });

  /* Photos uploaded in this edit but never saved are removed again when the editor is cancelled. */
  function discardNewPhotos() {
    const fresh = images.filter((path) => !originalImages.includes(path)).concat(isFile(logo) && logo !== originalLogo ? [logo] : []);
    if (fresh.length) sb.storage.from(BUCKET).remove(fresh).catch(() => {});
    images = originalImages.slice();
    logo = originalLogo;
  }

  /* Shows only the sections that matter: the single price box or the options, the VPN plan or the delivery text. */
  function syncSections() {
    const hasOptions = opts.length > 0;
    byId('pp-simple-price').hidden = hasOptions;
    byId('pp-plan-card').hidden = theme() !== 'plan';
    byId('pp-photos-field').hidden = theme() === 'plan';
    byId('pp-vpn-card').hidden = !isVpn();
    byId('pp-vpn-client-card').hidden = !isVpn();
    byId('pp-vpn-panel-note').hidden = !(isVpn() && hasPanel === false);
    byId('pp-delivery-card').hidden = isVpn();
    byId('pp-vpn-simple').hidden = hasOptions;
    byId('pp-vpn-options-note').hidden = !(isVpn() && hasOptions);
    byId('pp-add-option').hidden = opts.length >= MAX_OPTIONS;
    byId('pp-add-option').querySelector('span').textContent = hasOptions ? 'Add another option' : 'Add options instead (for example 30 days, 60 days)';
  }

  form.elements.icon.addEventListener('change', () => {
    const category = form.elements.category;
    if (isVpn() && Array.from(category.options).some((o) => o.value === 'VPN')) category.value = 'VPN';
    renderOptions();
    syncSections();
  });
  form.elements.category.addEventListener('change', () => {
    if (form.elements.category.value === 'VPN') form.elements.icon.value = 'vpn';
    renderOptions();
    syncSections();
  });
  form.addEventListener('input', (event) => {
    if (event.target.getAttribute && event.target.getAttribute('aria-invalid') === 'true') showFieldError(event.target, '');
  });

  /* ----- Photos ----- */
  function renderPhotos() {
    byId('pp-photos').innerHTML = images.map((path, i) => `
      <figure class="pp-photo${i === 0 ? ' is-cover' : ''}">
        <img src="${esc(photoUrl(path))}" alt="Photo ${i + 1}">
        ${i === 0 ? '<span class="pp-photo__tag">Cover</span>' : `<button class="pp-photo__btn pp-photo__btn--star" type="button" data-cover="${i}" aria-label="Make this the cover photo" title="Make cover">${icon('i-star')}</button>`}
        <button class="pp-photo__btn pp-photo__btn--x" type="button" data-remove-photo="${i}" aria-label="Remove this photo" title="Remove">${icon('i-close')}</button>
      </figure>`).join('') + (uploading ? '<div class="pp-photo pp-photo--busy">Uploading…</div>' : '');
    byId('pp-upload-label').hidden = images.length >= MAX_PHOTOS;
  }

  byId('pp-photos').addEventListener('click', (event) => {
    const cover = event.target.closest('[data-cover]');
    if (cover) {
      const i = Number(cover.dataset.cover);
      images.unshift(images.splice(i, 1)[0]);
      renderPhotos();
      return;
    }
    const remove = event.target.closest('[data-remove-photo]');
    if (remove) {
      images.splice(Number(remove.dataset.removePhoto), 1);
      renderPhotos();
    }
  });

  /* Shrinks a photo to at most 1400 pixels so shop pages stay fast. */
  function shrink(file, limit) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, (limit || 1400) / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        /* JPEG has no transparency, so a transparent logo would turn black without a white background. */
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read that image.'))), 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a usable image.')); };
      img.src = url;
    });
  }

  byId('pp-photo-input').addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    showBox('pp-photo-error', '');
    const room = MAX_PHOTOS - images.length;
    if (files.length > room) showBox('pp-photo-error', `Only ${MAX_PHOTOS} photos are allowed, so ${files.length - room} ${plural(files.length - room, 'was', 'were')} skipped.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { showBox('pp-photo-error', 'Use JPG, PNG or WebP photos.'); continue; }
      uploading += 1;
      renderPhotos();
      try {
        const blob = await shrink(file);
        const path = `${sellerRow.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
        if (error) throw error;
        images.push(path);
      } catch (err) {
        showBox('pp-photo-error', (err && err.message) || 'Could not upload that photo.');
      } finally {
        uploading -= 1;
        renderPhotos();
      }
    }
  });

  /* ----- Options ----- */
  function renderOptions() {
    const vpn = isVpn();
    byId('pp-options').innerHTML = opts.map((o, i) => `
      <div class="pp-option" data-index="${i}">
        <div class="field pp-option__label">
          <label for="pp-o-label-${i}">Option name</label>
          <input id="pp-o-label-${i}" data-field="label" type="text" maxlength="60" value="${esc(o.label)}" placeholder="For example 30 days">
        </div>
        <div class="field">
          <label for="pp-o-price-${i}">Price (Rs.)</label>
          <input id="pp-o-price-${i}" data-field="price" type="number" min="1" step="1" inputmode="numeric" value="${esc(o.price)}">
        </div>
        <div class="field">
          <label for="pp-o-stock-${i}">In stock</label>
          <input id="pp-o-stock-${i}" data-field="stock" type="number" min="0" step="1" inputmode="numeric" value="${esc(o.stock)}" placeholder="Unlimited">
        </div>
        ${vpn ? `
        <div class="field">
          <label for="pp-o-days-${i}">Days</label>
          <input id="pp-o-days-${i}" data-field="days" type="number" min="1" max="3650" step="1" inputmode="numeric" value="${esc(o.days)}" placeholder="30">
        </div>
        <div class="field">
          <label for="pp-o-gb-${i}">Data (GB)</label>
          <input id="pp-o-gb-${i}" data-field="gb" type="number" min="0" step="1" inputmode="numeric" value="${esc(o.gb)}" placeholder="0 = unlimited">
        </div>` : ''}
        <button class="icon-btn icon-btn--sm icon-btn--danger pp-option__x" type="button" data-remove-option="${i}" aria-label="Remove this option">${icon('i-trash')}</button>
      </div>`).join('');
  }

  byId('pp-options').addEventListener('input', (event) => {
    const input = event.target;
    const row = input.closest('[data-index]');
    if (!row || !input.dataset.field) return;
    opts[Number(row.dataset.index)][input.dataset.field] = input.value;
    showBox('pp-options-error', '');
  });

  byId('pp-options').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-option]');
    if (!remove) return;
    opts.splice(Number(remove.dataset.removeOption), 1);
    renderOptions();
    syncSections();
  });

  byId('pp-add-option').addEventListener('click', () => {
    if (opts.length >= MAX_OPTIONS) return;
    opts.push({ label: '', price: '', stock: '', days: isVpn() ? '30' : '', gb: isVpn() ? '0' : '' });
    renderOptions();
    syncSections();
    const last = byId('pp-options').querySelector('[data-index]:last-child [data-field="label"]');
    if (last) last.focus();
  });

  /* ----- Plan card: logo, key figures and detail lines ----- */
  form.querySelectorAll('input[name="theme"]').forEach((radio) => radio.addEventListener('change', syncSections));

  function renderLogo() {
    byId('pp-logo').innerHTML = logo
      ? `<figure class="pp-photo pp-photo--logo"><img src="${esc(logoUrl(logo))}" alt="Logo"><button class="pp-photo__btn pp-photo__btn--x" type="button" data-remove-logo aria-label="Remove the logo" title="Remove">${icon('i-close')}</button></figure>`
      : '';
    byId('pp-logo-label').textContent = 'Upload my own';
  }

  byId('pp-logo').addEventListener('click', (event) => {
    if (!event.target.closest('[data-remove-logo]')) return;
    if (isFile(logo) && logo !== originalLogo) sb.storage.from(BUCKET).remove([logo]).catch(() => {});
    logo = '';
    renderLogo();
  });

  byId('pp-logo-input').addEventListener('change', async (event) => {
    const file = (event.target.files || [])[0];
    event.target.value = '';
    showBox('pp-logo-error', '');
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { showBox('pp-logo-error', 'Use a JPG, PNG or WebP image.'); return; }
    uploading += 1;
    try {
      const blob = await shrink(file, 600);
      const path = `${sellerRow.id}/${Date.now()}-logo-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
      if (error) throw error;
      if (isFile(logo) && logo !== originalLogo) sb.storage.from(BUCKET).remove([logo]).catch(() => {});
      logo = path;
      renderLogo();
    } catch (err) {
      showBox('pp-logo-error', (err && err.message) || 'Could not upload the logo.');
    } finally {
      uploading -= 1;
    }
  });

  /* ----- Brand logo library (Simple Icons): search, click a logo, done ----- */
  const logoDialog = byId('pp-logo-dialog');
  const LIBRARY_URL = 'https://cdn.jsdelivr.net/npm/simple-icons@latest/data/simple-icons.json';
  const POPULAR = ['airtel', 'netflix', 'spotify', 'youtube', 'telegram', 'whatsapp', 'tiktok', 'instagram', 'facebook', 'x', 'google', 'apple',
    'microsoft', 'disneyplus', 'hbo', 'primevideo', 'amazon', 'paypal', 'steam', 'discord', 'twitch', 'github', 'nordvpn', 'expressvpn', 'protonvpn',
    'cloudflare', 'wireguard', 'openvpn', 'adobe', 'figma', 'notion', 'zoom', 'linkedin', 'snapchat', 'reddit', 'pinterest'];
  const SHOW_MAX = 60;
  let ownBrands = [];      // the owner's shared logos: { name, path }
  let library = null;      // [{ title, slug, hex }] once loaded
  let libraryLoading = null;
  let searchTimer = 0;

  function loadLibrary() {
    if (library) return Promise.resolve(library);
    if (!libraryLoading) {
      libraryLoading = fetch(LIBRARY_URL)
        .then((res) => { if (!res.ok) throw new Error('bad answer'); return res.json(); })
        .then((list) => { library = list.map((i) => ({ title: i.title, slug: i.slug, hex: i.hex })); return library; })
        .catch((err) => { libraryLoading = null; throw err; });
    }
    return libraryLoading;
  }

  function renderLogoGrid() {
    const query = byId('pp-logo-search').value.trim().toLowerCase();
    const words = query ? query.split(/\s+/) : [];
    const grid = byId('pp-logo-grid');
    if (!library) return;
    /* The owner's own brands (Dialog, Mobitel, Hutch, SLT...) always come first. */
    const mine = ownBrands.filter((b) => words.every((w) => b.name.toLowerCase().includes(w)));
    let list;
    if (query) {
      list = library.filter((i) => words.every((w) => i.title.toLowerCase().includes(w) || i.slug.includes(w)));
      list.sort((a, b) => (a.title.toLowerCase().startsWith(query) ? 0 : 1) - (b.title.toLowerCase().startsWith(query) ? 0 : 1));
    } else {
      list = POPULAR.map((slug) => library.find((i) => i.slug === slug)).filter(Boolean);
    }
    const shown = list.slice(0, Math.max(0, SHOW_MAX - mine.length));
    const total = list.length + mine.length;
    if (query) {
      byId('pp-logo-count').textContent = total
        ? `${total} ${plural(total, 'logo', 'logos')} found${total > SHOW_MAX ? `, showing the first ${SHOW_MAX}. Type more to narrow it down.` : '.'}`
        : 'No logo found. Try another word, or upload your own image.';
    } else {
      byId('pp-logo-count').textContent = mine.length ? 'Our brands first, then popular brands. Type to search all 3,000+ logos.' : 'Popular brands. Type to search all 3,000+ logos.';
    }
    const ownHtml = mine.map((b) => `
      <button class="pp-logo-item" type="button" data-path="${esc(b.path)}" title="${esc(b.name)}">
        <span class="pp-logo-item__img"><img src="${esc(photoUrl(b.path))}" alt="" loading="lazy"></span>
        <span class="pp-logo-item__name">${esc(b.name)}</span>
      </button>`).join('');
    grid.innerHTML = ownHtml + shown.map((i) => `
      <button class="pp-logo-item" type="button" data-slug="${esc(i.slug)}" title="${esc(i.title)}">
        <span class="pp-logo-item__img"><img src="https://cdn.simpleicons.org/${encodeURIComponent(i.slug)}" alt="" loading="lazy"></span>
        <span class="pp-logo-item__name">${esc(i.title)}</span>
      </button>`).join('');
  }

  byId('pp-logo-library').addEventListener('click', async () => {
    byId('pp-logo-search').value = '';
    byId('pp-logo-grid').innerHTML = '';
    byId('pp-logo-count').textContent = 'Loading logos…';
    if (!logoDialog.open) logoDialog.showModal();
    byId('pp-logo-search').focus();
    try {
      const own = await sb.from('brand_logos').select('name, path').order('name');
      ownBrands = own.data || [];
      await loadLibrary();
      renderLogoGrid();
    } catch (e) {
      byId('pp-logo-count').textContent = 'Could not load the logo library. Check your connection, or upload your own image.';
    }
  });

  byId('pp-logo-search').addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(renderLogoGrid, 120);
  });

  byId('pp-logo-grid').addEventListener('click', (event) => {
    const item = event.target.closest('[data-slug], [data-path]');
    if (!item) return;
    if (isFile(logo) && logo !== originalLogo) sb.storage.from(BUCKET).remove([logo]).catch(() => {});
    logo = item.dataset.path ? item.dataset.path : LIB + item.dataset.slug;
    showBox('pp-logo-error', '');
    renderLogo();
    logoDialog.close();
  });

  byId('pp-logo-close').addEventListener('click', () => logoDialog.close());
  logoDialog.addEventListener('click', (event) => { if (event.target === logoDialog) logoDialog.close(); });

  function renderStats() {
    byId('pp-stats').innerHTML = stats.map((s, i) => `
      <div class="pp-rowitem" data-index="${i}">
        <input data-field="value" type="text" maxlength="12" value="${esc(s.value)}" placeholder="100" aria-label="Value ${i + 1}">
        <input data-field="label" type="text" maxlength="14" value="${esc(s.label)}" placeholder="GB" aria-label="Label ${i + 1}">
        <button class="icon-btn icon-btn--sm icon-btn--danger" type="button" data-remove-stat="${i}" aria-label="Remove this key figure">${icon('i-trash')}</button>
      </div>`).join('');
    byId('pp-add-stat').hidden = stats.length >= 3;
  }

  function renderInfo() {
    byId('pp-info').innerHTML = info.map((row, i) => `
      <div class="pp-rowitem pp-rowitem--info" data-index="${i}">
        <select data-field="icon" aria-label="Icon ${i + 1}">${ICONS.map(([id, name]) => `<option value="${id}"${row.icon === id ? ' selected' : ''}>${name}</option>`).join('')}</select>
        <input data-field="text" type="text" maxlength="140" value="${esc(row.text)}" placeholder="For example Monthly capacity: 7.80 TB left" aria-label="Detail line ${i + 1}">
        <button class="icon-btn icon-btn--sm icon-btn--danger" type="button" data-remove-info="${i}" aria-label="Remove this line">${icon('i-trash')}</button>
      </div>`).join('');
    byId('pp-add-info').hidden = info.length >= 6;
  }

  byId('pp-add-stat').addEventListener('click', () => { stats.push({ value: '', label: '' }); renderStats(); });
  byId('pp-add-info').addEventListener('click', () => { info.push({ icon: 'info', text: '' }); renderInfo(); });

  byId('pp-stats').addEventListener('input', (event) => {
    const row = event.target.closest('[data-index]');
    if (row && event.target.dataset.field) stats[Number(row.dataset.index)][event.target.dataset.field] = event.target.value;
  });
  byId('pp-info').addEventListener('input', (event) => {
    const row = event.target.closest('[data-index]');
    if (row && event.target.dataset.field) info[Number(row.dataset.index)][event.target.dataset.field] = event.target.value;
  });
  byId('pp-stats').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-stat]');
    if (remove) { stats.splice(Number(remove.dataset.removeStat), 1); renderStats(); }
  });
  byId('pp-info').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-info]');
    if (remove) { info.splice(Number(remove.dataset.removeInfo), 1); renderInfo(); }
  });

  /* ----- Save ----- */
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = form.elements;
    showBox('pp-form-error', '');
    showBox('pp-options-error', '');
    let ok = true;

    const name = f.name.value.trim();
    if (name.length < 3 || name.length > 80) { showFieldError(f.name, 'Enter a title of 3 to 80 characters.'); ok = false; }

    const vpn = isVpn();
    const options = [];
    let price = null;
    let stock = null;
    let vpnDays = 30;
    let vpnGb = 0;

    if (opts.length) {
      for (const [i, o] of opts.entries()) {
        const label = o.label.trim();
        const p = readInt(o.price);
        const s = readInt(o.stock);
        const d = readInt(o.days);
        const g = readInt(o.gb);
        const where = `Option ${i + 1}`;
        if (!label) { showBox('pp-options-error', `${where} needs a name.`); ok = false; break; }
        if (p == null || Number.isNaN(p) || p <= 0) { showBox('pp-options-error', `${where} needs a price above 0 (whole rupees).`); ok = false; break; }
        if (Number.isNaN(s) || (s != null && s < 0)) { showBox('pp-options-error', `${where}: stock must be 0 or more, or empty for unlimited.`); ok = false; break; }
        if (vpn && (Number.isNaN(d) || (d != null && (d < 1 || d > 3650)))) { showBox('pp-options-error', `${where}: days must be 1 to 3650.`); ok = false; break; }
        if (vpn && (Number.isNaN(g) || (g != null && g < 0))) { showBox('pp-options-error', `${where}: data must be 0 or more.`); ok = false; break; }
        const option = { label, price: p, stock: s };
        if (vpn) { option.days = d == null ? 30 : d; option.gb = g == null ? 0 : g; }
        options.push(option);
      }
      if (ok) price = Math.min(...options.map((o) => o.price));
    } else {
      price = readInt(f.price.value);
      if (price == null || Number.isNaN(price) || price <= 0) { showFieldError(f.price, 'Enter a price above 0 (whole rupees).'); ok = false; }
      stock = readInt(f.stock.value);
      if (Number.isNaN(stock) || (stock != null && stock < 0)) { showFieldError(f.stock, 'Enter 0 or more, or leave empty for unlimited.'); ok = false; }
      if (vpn) {
        vpnDays = readInt(f.vpnDays.value);
        vpnGb = readInt(f.vpnGb.value);
        if (vpnDays == null || Number.isNaN(vpnDays) || vpnDays < 1 || vpnDays > 3650) { showFieldError(f.vpnDays, 'Enter 1 to 3650 days.'); ok = false; }
        if (vpnGb == null || Number.isNaN(vpnGb) || vpnGb < 0) { showFieldError(f.vpnGb, 'Enter 0 or more.'); ok = false; }
      }
    }
    showBox('pp-plan-error', '');
    const plan = theme() === 'plan';
    const cleanStats = stats.map((s) => ({ value: s.value.trim(), label: s.label.trim() })).filter((s) => s.value || s.label);
    const cleanInfo = info.map((row) => ({ icon: row.icon, text: row.text.trim() })).filter((row) => row.text);
    if (plan) {
      if (cleanStats.some((s) => !s.value)) { showBox('pp-plan-error', 'Every key figure needs a value.'); ok = false; }
      else if (!logo) { showBox('pp-plan-error', 'Add a logo or icon for the plan card (or choose the Photos style).'); ok = false; }
    }
    const vpnSettings = vpn ? readVpnSettings() : {};
    if (!vpnSettings) ok = false;
    if (uploading) { showBox('pp-form-error', 'Wait for the photos to finish uploading.'); ok = false; }
    if (!ok) return;

    const payload = {
      name,
      description: f.description.value.trim(),
      category: f.category.value,
      icon: f.icon.value,
      type: f.type.value.trim().slice(0, 12),
      price,
      stock: opts.length ? null : stock,
      options,
      images: plan ? [] : images,
      theme: plan ? 'plan' : 'standard',
      logo: plan && logo ? logo : null,
      badge: plan ? f.badge.value.trim().slice(0, 40) : '',
      stats: plan ? cleanStats : [],
      info: plan ? cleanInfo : [],
      sold_out: f.soldOut.checked,
      show_stock: f.showStock.checked,
      status: f.hidden.checked ? 'hidden' : 'active',
      delivery_info: vpn ? '' : f.deliveryInfo.value.trim(),
      vpn_days: vpn && !opts.length ? vpnDays : 30,
      vpn_data_gb: vpn && !opts.length ? vpnGb : 0,
      vpn_settings: vpnSettings
    };

    const editingId = f.productId.value;
    const saveButton = byId('pp-save');
    saveButton.disabled = true;
    const result = editingId
      ? await sb.from('products').update(payload).eq('id', editingId).select().maybeSingle()
      : await sb.from('products').insert(Object.assign({ seller_id: sellerRow.id }, payload)).select().maybeSingle();
    saveButton.disabled = false;
    if (result.error || !result.data) {
      showBox('pp-form-error', (result.error && result.error.message) || 'Could not save the product. Please try again.');
      return;
    }

    /* Photos that were taken off this product are deleted from storage. */
    const keptImages = payload.images;
    const keptLogo = payload.logo;
    const removed = originalImages.filter((path) => !keptImages.includes(path))
      .concat(originalLogo && originalLogo !== keptLogo ? [originalLogo] : [])
      .concat(logo && logo !== keptLogo ? [logo] : [])
      .filter(isFile);
    if (removed.length) sb.storage.from(BUCKET).remove(removed).catch(() => {});
    originalImages = images.slice();
    originalLogo = keptLogo || '';

    if (editingId) products = products.map((p) => (p.id === editingId ? result.data : p));
    else products.unshift(result.data);
    renderList();
    closeEditor();
    toast(editingId ? 'Product saved' : 'Product added');
  });

  document.title = `Your products | ${CFG.storeName}`;
  start();
})();


