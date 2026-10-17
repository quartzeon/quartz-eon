/* Quartz Eon: admin page. Owner-only. Not linked from the public site — reached by typing
   admin.html in the browser. Real access control is the database's row-level security (an
   "is_admin()" check, see supabase/schema.sql), not this page being hard to find. */
(function () {
  'use strict';

  const CFG = Object.assign({ storeName: 'Quartz Eon' }, window.QE_CONFIG);
  const sb = window.QE_SUPABASE;
  const root = document.documentElement;
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  const byId = (id) => document.getElementById(id);
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  const icon = (id) => `<svg class="i" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
  const plural = (n, one, many) => (n === 1 ? one : many);
  const storage = {
    get(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }
  };

  /* ---------- Theme (same rule as the storefront: explicit choice wins, otherwise the device) ---------- */
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

  /* ---------- Toasts ---------- */
  let toastTimer = 0;
  function toast(message) {
    const box = byId('admin-toasts');
    box.innerHTML = `<div class="toast"><span>${esc(message)}</span></div>`;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { box.innerHTML = ''; }, 3200);
  }

  /* ---------- Log in form ---------- */
  const loginForm = byId('admin-login-form');

  function showFieldError(input, message) {
    const error = byId(`${input.id}-error`);
    if (!error) return;
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    error.textContent = message || '';
    error.hidden = !message;
  }

  function friendlyAuthError(err) {
    const msg = (err && err.message) || '';
    if (/invalid login credentials/i.test(msg)) return 'That email and password do not match.';
    if (/rate limit/i.test(msg)) return 'Too many attempts. Please wait a minute and try again.';
    if (/captcha/i.test(msg)) return 'The "Verify you are human" check failed. Please try again.';
    return msg || 'Something went wrong. Please try again.';
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  loginForm.addEventListener('input', (event) => {
    if (event.target.getAttribute('aria-invalid') === 'true') showFieldError(event.target, '');
  });

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = loginForm.elements.email.value.trim();
    byId('admin-form-error').hidden = true;
    byId('admin-login-note').hidden = true;
    if (!EMAIL_RE.test(email)) {
      showFieldError(loginForm.elements.email, 'Enter a valid email address.');
      return;
    }
    const submitButton = loginForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = 'Please wait…';
    const captcha = window.QE_CAPTCHA.attach(loginForm);
    let error = null;
    try {
      const captchaToken = await captcha.token();
      ({ error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin + window.location.pathname, captchaToken }
      }));
    } catch (err) {
      error = err;
    }
    captcha.reset();
    submitButton.disabled = false;
    submitButton.textContent = 'Email me a log in link';
    if (error) {
      const note = byId('admin-form-error');
      note.textContent = friendlyAuthError(error);
      note.hidden = false;
    } else {
      byId('admin-login-note').hidden = false;
    }
  });

  byId('admin-logout').addEventListener('click', async () => {
    await sb.auth.signOut();
  });

  /* ---------- Which panel is showing: log in, access denied, or the dashboard ---------- */
  function showPanel(name, email) {
    byId('admin-login').hidden = name !== 'login';
    byId('admin-denied').hidden = name !== 'denied';
    byId('admin-app').hidden = name !== 'app';
    byId('admin-logout').hidden = name === 'login';
    if (name === 'denied') byId('admin-denied-email').textContent = email || '';
    if (name === 'login') window.QE_CAPTCHA.attach(loginForm);
  }

  /* Currency picker: the same one as the shop header. */
  const M = window.QE_MONEY;
  M.mountPicker(byId('cur-widget'), 'Amounts are shown in this currency. Payments stay in the original currency.');
  M.onChange(() => {
    if (byId('admin-app').hidden) return;
    renderProducts();
    renderOrders();
    renderFees();
    renderSpotRequests();
    renderSpotPacks();
  });

  sb.auth.onAuthStateChange(async (event, session) => {
    if (!session) {
      showPanel('login');
      return;
    }
    const { data: profile } = await sb.from('profiles').select('role').eq('id', session.user.id).maybeSingle();
    if (profile && profile.role === 'admin') {
      showPanel('app');
      await loadSellers();
      loadProducts();
      loadAds().then(loadSpotRequests); /* both lists show store names, loaded above; requests show their ad */
      loadSpotPacks();
      loadOwnerTelegram();
      loadOrders().then(loadReports); /* reports show the order's product name */
      loadOwnerBank();
      loadBrands();
      loadFees().then(forgetSlips);
      loadFeeSettings();
    } else {
      showPanel('denied', session.user.email);
    }
  });

  /* ---------- Sellers list ---------- */
  let sellers = [];
  let statusFilter = 'all';
  const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', suspended: 'Suspended' };

  async function loadSellers() {
    byId('sellers-list').innerHTML = '<p class="admin-lead">Loading…</p>';
    const { data, error } = await sb.from('sellers').select('*').order('created_at', { ascending: false });
    if (error) {
      byId('sellers-list').innerHTML = '';
      toast(`Could not load sellers: ${error.message}`);
      return;
    }
    const ids = data.map((s) => s.id);
    let emailById = {};
    if (ids.length) {
      const { data: people } = await sb.from('profiles').select('id, email').in('id', ids);
      emailById = Object.fromEntries((people || []).map((p) => [p.id, p.email]));
    }
    sellers = data.map((s) => Object.assign({ email: emailById[s.id] || '' }, s));
    renderSellers();
  }

  function formatDate(value) {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function sellerRow(s) {
    const badge = `<span class="status-badge status-badge--${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
    const actions = [];
    if (s.status === 'pending') {
      actions.push(`<button class="btn btn--ink btn--sm" type="button" data-approve="${esc(s.id)}">${icon('i-check')}<span>Approve</span></button>`);
      actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-suspend="${esc(s.id)}">${icon('i-pause')}<span>Reject</span></button>`);
    } else if (s.status === 'approved') {
      actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-suspend="${esc(s.id)}">${icon('i-pause')}<span>Suspend</span></button>`);
    } else {
      actions.push(`<button class="btn btn--ink btn--sm" type="button" data-approve="${esc(s.id)}">${icon('i-play')}<span>Reactivate</span></button>`);
    }
    /* Only a store that is not live can be deleted, so a working shop is never removed by a stray click. */
    if (s.status !== 'approved') {
      actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-delete-seller="${esc(s.id)}" aria-label="Delete ${esc(s.store_name)}">${icon('i-trash')}<span>Delete</span></button>`);
    }
    return `
      <article class="seller-row" style="--h:${Number(s.hue) || 0}">
        <div class="seller-row__main">
          <span class="seller-row__avatar">${icon('i-store')}</span>
          <div class="seller-row__text">
            <p class="seller-row__name"><a href="index.html#/store/${esc(s.store_slug)}" target="_blank" rel="noopener">${esc(s.store_name)}</a> ${badge}</p>
            <p class="seller-row__meta">${esc(s.email)} &middot; /store/${esc(s.store_slug)} &middot; joined ${formatDate(s.created_at)} &middot; free until ${formatDate(s.free_until)}${s.paid_until ? ` &middot; paid until ${formatDate(s.paid_until)}` : ''}</p>
          </div>
        </div>
        <div class="seller-row__actions">${actions.join('')}</div>
      </article>`;
  }

  function renderSellers() {
    const list = statusFilter === 'all' ? sellers : sellers.filter((s) => s.status === statusFilter);
    byId('sellers-list').innerHTML = list.map(sellerRow).join('');
    byId('sellers-list').hidden = list.length === 0;
    byId('sellers-empty').hidden = list.length > 0;
    byId('sellers-count').textContent = `${sellers.length} total · ${list.length} shown`;
    fillAdForm(); /* the ad form lists the approved stores */
    if (ads.length) renderAds(); else if (spotRequests.length) renderSpotRequests();
  }

  byId('status-tabs').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-status]');
    if (!chip) return;
    statusFilter = chip.dataset.status;
    byId('status-tabs').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    renderSellers();
  });

  async function setStatus(id, status) {
    const { error } = await sb.from('sellers').update({ status }).eq('id', id);
    if (error) {
      toast(`Could not update: ${error.message}`);
      return;
    }
    const s = sellers.find((row) => row.id === id);
    if (s) s.status = status;
    renderSellers();
    toast(status === 'approved' ? 'Store approved' : status === 'suspended' ? 'Store suspended' : 'Updated');
  }

  async function deleteSeller(id) {
    const seller = sellers.find((row) => row.id === id);
    const name = seller ? seller.store_name : 'this store';
    if (!window.confirm(`Delete "${name}" for good? Its login, products and bank details are removed and this cannot be undone.`)) return;
    const { error } = await sb.rpc('delete_seller', { p_seller_id: id });
    if (error) {
      toast(`Could not delete: ${error.message}`);
      return;
    }
    sellers = sellers.filter((row) => row.id !== id);
    ads = ads.filter((a) => a.seller_id !== id); /* its ads and ad requests were deleted with it */
    spotRequests = spotRequests.filter((r) => r.seller_id !== id);
    renderSellers();
    toast('Store deleted');
    loadProducts();
  }

  byId('sellers-list').addEventListener('click', (event) => {
    const approve = event.target.closest('[data-approve]');
    if (approve) { setStatus(approve.dataset.approve, 'approved'); return; }
    const suspend = event.target.closest('[data-suspend]');
    if (suspend) { setStatus(suspend.dataset.suspend, 'suspended'); return; }
    const remove = event.target.closest('[data-delete-seller]');
    if (remove) deleteSeller(remove.dataset.deleteSeller);
  });

  /* ---------- Sections: Sellers and Products ---------- */
  byId('section-tabs').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-section]');
    if (!chip) return;
    byId('section-tabs').querySelectorAll('[data-section]').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    byId('sellers-section').hidden = chip.dataset.section !== 'sellers';
    byId('products-section').hidden = chip.dataset.section !== 'products';
    byId('orders-section').hidden = chip.dataset.section !== 'orders';
    byId('reports-section').hidden = chip.dataset.section !== 'reports';
    byId('settings-section').hidden = chip.dataset.section !== 'settings';
    byId('fees-section').hidden = chip.dataset.section !== 'fees';
    byId('spots-section').hidden = chip.dataset.section !== 'spots';
  });

  /* ---------- Products list (moderation: hide, show again, delete) ---------- */
  let products = [];
  let productFilter = 'all';

  async function loadProducts() {
    byId('products-list').innerHTML = '<p class="admin-lead">Loading…</p>';
    const { data, error } = await sb.from('products').select('*').order('created_at', { ascending: false });
    if (error) {
      byId('products-list').innerHTML = '';
      toast(`Could not load products: ${error.message}`);
      return;
    }
    products = data || [];
    renderProducts();
  }

  function productRow(p) {
    const store = sellers.find((s) => s.id === p.seller_id);
    const hidden = p.status === 'hidden';
    const badge = `<span class="status-badge status-badge--${hidden ? 'suspended' : 'approved'}">${hidden ? 'Hidden' : 'Active'}</span>`;
    const toggle = hidden
      ? `<button class="btn btn--ink btn--sm" type="button" data-show="${esc(p.id)}">${icon('i-play')}<span>Show</span></button>`
      : `<button class="btn btn--ghost btn--sm" type="button" data-hide="${esc(p.id)}">${icon('i-pause')}<span>Hide</span></button>`;
    return `
      <article class="seller-row" style="--h:${Number(store && store.hue) || 0}">
        <div class="seller-row__main">
          <span class="seller-row__avatar"><svg class="art" aria-hidden="true" focusable="false"><use href="#a-${esc(p.icon)}"/></svg></span>
          <div class="seller-row__text">
            <p class="seller-row__name">${esc(p.name)} ${badge}</p>
            <p class="seller-row__meta">${esc(store ? store.store_name : 'Unknown store')} &middot; ${esc(p.category)} &middot; ${esc(M.dual(p.price, store && store.currency))}${p.type ? ` &middot; ${esc(p.type)}` : ''}</p>
          </div>
        </div>
        <div class="seller-row__actions">
          ${toggle}
          <button class="btn btn--ghost btn--sm" type="button" data-remove="${esc(p.id)}" aria-label="Delete ${esc(p.name)}">${icon('i-trash')}<span>Delete</span></button>
        </div>
      </article>`;
  }

  function renderProducts() {
    const list = productFilter === 'all' ? products : products.filter((p) => p.status === productFilter);
    byId('products-list').innerHTML = list.map(productRow).join('');
    byId('products-list').hidden = list.length === 0;
    byId('products-empty').hidden = list.length > 0;
    byId('products-count').textContent = `${products.length} ${plural(products.length, 'product', 'products')} · ${list.length} shown`;
  }

  byId('product-status-tabs').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-pstatus]');
    if (!chip) return;
    productFilter = chip.dataset.pstatus;
    byId('product-status-tabs').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    renderProducts();
  });

  async function setProductStatus(id, status) {
    const { error } = await sb.from('products').update({ status }).eq('id', id);
    if (error) {
      toast(`Could not update: ${error.message}`);
      return;
    }
    const p = products.find((row) => row.id === id);
    if (p) p.status = status;
    renderProducts();
    toast(status === 'hidden' ? 'Product hidden' : 'Product is live again');
  }

  async function removeProduct(id) {
    const { error } = await sb.from('products').delete().eq('id', id);
    if (error) {
      toast(`Could not delete: ${error.message}`);
      return;
    }
    products = products.filter((p) => p.id !== id);
    renderProducts();
    toast('Product deleted');
  }

  byId('products-list').addEventListener('click', (event) => {
    const hide = event.target.closest('[data-hide]');
    if (hide) { setProductStatus(hide.dataset.hide, 'hidden'); return; }
    const show = event.target.closest('[data-show]');
    if (show) { setProductStatus(show.dataset.show, 'active'); return; }
    const remove = event.target.closest('[data-remove]');
    if (remove && window.confirm('Delete this product? This cannot be undone.')) removeProduct(remove.dataset.remove);
  });

  /* ---------- Orders: check a bank transfer, approve or reject it, retry VPN delivery ---------- */
  let orders = [];
  let orderFilter = 'awaiting_review';
  const ORDER_BADGE = { awaiting_review: ['pending', 'Waiting for review'], paid: ['approved', 'Paid'], rejected: ['suspended', 'Not accepted'] };

  async function loadOrders() {
    byId('orders-list').innerHTML = '<p class="admin-lead">Loading…</p>';
    const { data, error } = await sb.from('orders').select('*').order('created_at', { ascending: false });
    if (error) {
      byId('orders-list').innerHTML = '';
      toast(`Could not load orders: ${error.message}`);
      return;
    }
    const ids = Array.from(new Set((data || []).map((o) => o.customer_id)));
    let emailById = {};
    if (ids.length) {
      const { data: people } = await sb.from('profiles').select('id, email').in('id', ids);
      emailById = Object.fromEntries((people || []).map((p) => [p.id, p.email]));
    }
    orders = (data || []).map((o) => Object.assign({ customer_email: emailById[o.customer_id] || '' }, o));
    renderOrders();
  }

  function orderRow(o) {
    const [badgeClass, label] = ORDER_BADGE[o.status] || ['pending', o.status];
    const store = sellers.find((s) => s.id === o.seller_id);
    const amount = o.method === 'paypal' && o.amount_usd ? `$${Number(o.amount_usd).toFixed(2)} via PayPal` : `${M.dual(o.amount_lkr, o.currency)} by bank transfer`;
    const actions = [];
    if (o.status === 'awaiting_review') {
      if (o.receipt_path) actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-slip="${esc(o.id)}"><span>View slip</span></button>`);
      actions.push(`<button class="btn btn--ink btn--sm" type="button" data-order-approve="${esc(o.id)}">${icon('i-check')}<span>Approve</span></button>`);
      actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-order-reject="${esc(o.id)}">${icon('i-pause')}<span>Reject</span></button>`);
    } else if (o.status === 'paid' && o.is_vpn && !o.delivery) {
      actions.push(`<button class="btn btn--ink btn--sm" type="button" data-order-retry="${esc(o.id)}">${icon('i-play')}<span>Retry VPN delivery</span></button>`);
    }
    const problem = o.delivery_error ? `<p class="seller-row__meta order-problem">VPN delivery failed: ${esc(o.delivery_error)}</p>` : '';
    return `
      <article class="seller-row" style="--h:${Number(store && store.hue) || 0}">
        <div class="seller-row__main">
          <span class="seller-row__avatar">${icon('i-store')}</span>
          <div class="seller-row__text">
            <p class="seller-row__name">${esc(o.product_name)} <span class="status-badge status-badge--${badgeClass}">${esc(label)}</span></p>
            <p class="seller-row__meta">${esc(o.customer_email)} &middot; ${amount} &middot; ${esc(store ? store.store_name : 'Unknown store')} &middot; ${formatDate(o.created_at)}</p>
            ${o.method === 'bank' ? `<p class="seller-row__meta">Reference: ${esc(o.reference)}</p>` : ''}
            ${problem}
          </div>
        </div>
        <div class="seller-row__actions">${actions.join('')}</div>
      </article>`;
  }

  function renderOrders() {
    const list = orderFilter === 'all' ? orders : orders.filter((o) => o.status === orderFilter);
    byId('orders-list').innerHTML = list.map(orderRow).join('');
    byId('orders-list').hidden = list.length === 0;
    byId('orders-empty').hidden = list.length > 0;
    byId('orders-count').textContent = `${orders.length} ${plural(orders.length, 'order', 'orders')} · ${list.length} shown`;
  }

  byId('order-status-tabs').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-ostatus]');
    if (!chip) return;
    orderFilter = chip.dataset.ostatus;
    byId('order-status-tabs').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    renderOrders();
  });

  /* Asks the server to set up the VPN client. Returns an error message, or '' on success. */
  async function deliverVpn(orderId) {
    const { data, error } = await sb.functions.invoke('fulfill-order', { body: { order_id: orderId } });
    if (!error && data && data.ok) return '';
    let message = (data && data.error) || (error && error.message) || 'Could not set up the VPN client.';
    try { const body = await error.context.json(); if (body && body.error) message = body.error; } catch (e) { /* keep the message above */ }
    return message;
  }

  async function approveOrder(id) {
    const { error } = await sb.rpc('approve_order', { p_order_id: id });
    if (error) { toast(`Could not approve: ${error.message}`); return; }
    emailCustomer(id);
    const order = orders.find((o) => o.id === id);
    if (order && order.is_vpn) {
      const problem = await deliverVpn(id);
      toast(problem ? `Approved, but VPN delivery failed: ${problem}` : 'Approved and VPN access created');
    } else {
      toast('Order approved');
    }
    loadOrders();
  }

  async function rejectOrder(id) {
    const { error } = await sb.rpc('reject_order', { p_order_id: id });
    if (error) { toast(`Could not reject: ${error.message}`); return; }
    emailCustomer(id);
    toast('Order rejected');
    loadOrders();
  }

  /* Tells the customer by email that the order was approved or rejected (the server sends it once). */
  function emailCustomer(orderId) {
    sb.functions.invoke('notify', { body: { kind: 'order_decided', id: orderId } }).catch(() => {});
  }

  async function retryDelivery(id) {
    const problem = await deliverVpn(id);
    toast(problem ? `Still failing: ${problem}` : 'VPN access created');
    loadOrders();
  }

  async function viewSlip(id) {
    const order = orders.find((o) => o.id === id);
    if (!order || !order.receipt_path) return;
    const popup = window.open('', '_blank');
    const { data, error } = await sb.storage.from('receipts').createSignedUrl(order.receipt_path, 300);
    if (error || !data) {
      if (popup) popup.close();
      toast('Could not open the slip.');
      return;
    }
    if (popup) popup.location.href = data.signedUrl;
    else window.location.href = data.signedUrl;
  }

  byId('orders-list').addEventListener('click', (event) => {
    const t = event.target;
    const approve = t.closest('[data-order-approve]');
    if (approve) { approveOrder(approve.dataset.orderApprove); return; }
    const reject = t.closest('[data-order-reject]');
    if (reject) { if (window.confirm('Reject this order? The customer will see it as not accepted.')) rejectOrder(reject.dataset.orderReject); return; }
    const retry = t.closest('[data-order-retry]');
    if (retry) { retryDelivery(retry.dataset.orderRetry); return; }
    const slip = t.closest('[data-slip]');
    if (slip) viewSlip(slip.dataset.slip);
  });

  /* ---------- Problem reports from customers ---------- */
  const REPORT_REASON = { not_received: 'Did not receive the purchase', not_working: 'It does not work', wrong_item: 'Not what was described', refund: 'Wants a refund', other: 'Something else' };
  let reports = [];

  async function loadReports() {
    const { data, error } = await sb.from('order_reports').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) { toast(`Could not load reports: ${error.message}`); return; }
    const ids = Array.from(new Set((data || []).map((r) => r.customer_id)));
    let emailById = {};
    if (ids.length) {
      const { data: people } = await sb.from('profiles').select('id, email').in('id', ids);
      emailById = Object.fromEntries((people || []).map((p) => [p.id, p.email]));
    }
    reports = (data || []).map((r) => Object.assign({ customer_email: emailById[r.customer_id] || '' }, r));
    renderReports();
  }

  function reportRow(r) {
    const store = sellers.find((s) => s.id === r.seller_id);
    const order = orders.find((o) => o.id === r.order_id);
    const open = r.status === 'open';
    return `
      <article class="seller-row" style="--h:${Number(store && store.hue) || 0}">
        <div class="seller-row__main">
          <span class="seller-row__avatar">${icon('i-store')}</span>
          <div class="seller-row__text">
            <p class="seller-row__name">${esc(REPORT_REASON[r.reason] || r.reason)} <span class="status-badge status-badge--${open ? 'pending' : 'approved'}">${open ? 'Open' : 'Resolved'}</span></p>
            <p class="seller-row__meta">${esc(r.customer_email)} &middot; ${esc(order ? order.product_name : 'Order')} &middot; ${esc(store ? store.store_name : 'Unknown store')} &middot; ${formatDate(r.created_at)}</p>
            <p class="seller-row__meta">${esc(r.message).replace(/\n/g, '<br>')}</p>
          </div>
        </div>
        <div class="seller-row__actions">${open ? `<button class="btn btn--ink btn--sm" type="button" data-report-resolve="${esc(r.id)}">${icon('i-check')}<span>Mark resolved</span></button>` : ''}</div>
      </article>`;
  }

  function renderReports() {
    const open = reports.filter((r) => r.status === 'open').length;
    byId('reports-list').innerHTML = reports.map(reportRow).join('');
    byId('reports-list').hidden = reports.length === 0;
    byId('reports-empty').hidden = reports.length > 0;
    byId('reports-count').textContent = `${reports.length} ${plural(reports.length, 'report', 'reports')} · ${open} open`;
  }

  byId('reports-list').addEventListener('click', async (event) => {
    const resolve = event.target.closest('[data-report-resolve]');
    if (!resolve) return;
    resolve.disabled = true;
    const { error } = await sb.from('order_reports').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', resolve.dataset.reportResolve);
    if (error) { resolve.disabled = false; toast(`Could not update: ${error.message}`); return; }
    toast('Report marked resolved');
    loadReports();
  });

  /* ---------- Settings: the owner's bank details, shown only to sellers (to pay the store fee) ---------- */
  const ownerBankForm = byId('owner-bank-form');

  async function loadOwnerBank() {
    const { data } = await sb.from('owner_bank_details').select('*').maybeSingle();
    if (!data) return;
    ownerBankForm.elements.bankName.value = data.bank_name || '';
    ownerBankForm.elements.branch.value = data.branch || '';
    ownerBankForm.elements.accountName.value = data.account_name || '';
    ownerBankForm.elements.accountNumber.value = data.account_number || '';
    ownerBankForm.elements.note.value = data.note || '';
    byId('owner-bank-saved').hidden = false;
    byId('owner-bank-saved').textContent = `Saved. Last updated ${formatDate(data.updated_at)}.`;
  }

  ownerBankForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    byId('owner-bank-error').hidden = true;
    const f = ownerBankForm.elements;
    const submitButton = ownerBankForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    const { error } = await sb.from('owner_bank_details').upsert({
      id: true,
      bank_name: f.bankName.value.trim(),
      branch: f.branch.value.trim(),
      account_name: f.accountName.value.trim(),
      account_number: f.accountNumber.value.trim(),
      note: f.note.value.trim(),
      updated_at: new Date().toISOString()
    });
    submitButton.disabled = false;
    if (error) {
      byId('owner-bank-error').textContent = error.message;
      byId('owner-bank-error').hidden = false;
      return;
    }
    byId('owner-bank-saved').hidden = false;
    byId('owner-bank-saved').textContent = 'Saved just now.';
    toast('Bank details saved');
  });

  /* ---------- Store fees: check a seller's slip, approve (adds 30 days and the Verified badge) or reject ---------- */
  let feePayments = [];
  let feeFilter = 'awaiting_review';
  const FEE_BADGE = { awaiting_review: ['pending', 'Waiting for review'], approved: ['approved', 'Approved'], rejected: ['suspended', 'Not accepted'] };

  async function loadFees() {
    const { data, error } = await sb.from('fee_payments').select('*').order('created_at', { ascending: false });
    if (error) { toast(`Could not load fee payments: ${error.message}`); return; }
    feePayments = data || [];
    renderFees();
  }

  /* Store fee and ad slips show a bank account and a name, so they are not kept: a rejected slip is deleted right
     away, an approved one 30 days after it was approved. The database lists them, this deletes the files, and only
     then are the paths cleared (so a failed delete is tried again next time). Runs quietly when the page opens. */
  async function forgetSlips() {
    const { data, error } = await sb.rpc('slips_to_forget');
    if (error) return;
    const paths = (data || []).map((r) => r.slip_path).filter(Boolean);
    if (!paths.length) return;
    const { error: removeError } = await sb.storage.from('receipts').remove(paths);
    if (removeError) return;
    await sb.rpc('forget_slips', { p_paths: paths });
    const gone = (row) => { if (paths.includes(row.receipt_path)) row.receipt_path = null; };
    feePayments.forEach(gone);
    spotRequests.forEach(gone);
    renderFees();
    renderSpotRequests();
  }

  function feeRow(p) {
    const [badgeClass, label] = FEE_BADGE[p.status] || ['pending', p.status];
    const store = sellers.find((s) => s.id === p.seller_id);
    const actions = [];
    if (p.receipt_path) actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-fee-slip="${esc(p.id)}"><span>View slip</span></button>`);
    if (p.status === 'awaiting_review') {
      actions.push(`<button class="btn btn--ink btn--sm" type="button" data-fee-approve="${esc(p.id)}">${icon('i-check')}<span>Approve</span></button>`);
      actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-fee-reject="${esc(p.id)}">${icon('i-pause')}<span>Reject</span></button>`);
    }
    return `
      <article class="seller-row" style="--h:${Number(store && store.hue) || 0}">
        <div class="seller-row__main">
          <span class="seller-row__avatar">${icon('i-store')}</span>
          <div class="seller-row__text">
            <p class="seller-row__name">${esc(store ? store.store_name : 'Unknown store')} <span class="status-badge status-badge--${badgeClass}">${esc(label)}</span></p>
            <p class="seller-row__meta">${esc(M.dual(p.amount_lkr, 'LKR'))} &middot; ${esc(store ? store.email : '')} &middot; ${formatDate(p.created_at)}${p.reference ? ` &middot; Reference: ${esc(p.reference)}` : ''}${p.receipt_path || p.status === 'awaiting_review' ? '' : ' &middot; Slip deleted'}</p>
          </div>
        </div>
        <div class="seller-row__actions">${actions.join('')}</div>
      </article>`;
  }

  function renderFees() {
    const list = feeFilter === 'all' ? feePayments : feePayments.filter((p) => p.status === feeFilter);
    byId('fees-list').innerHTML = list.map(feeRow).join('');
    byId('fees-list').hidden = list.length === 0;
    byId('fees-empty').hidden = list.length > 0;
    const waiting = feePayments.filter((p) => p.status === 'awaiting_review').length;
    byId('fees-count').textContent = `${feePayments.length} ${plural(feePayments.length, 'payment', 'payments')}${waiting ? ` · ${waiting} waiting` : ''}`;
  }

  byId('fee-status-tabs').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-fstatus]');
    if (!chip) return;
    feeFilter = chip.dataset.fstatus;
    byId('fee-status-tabs').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    renderFees();
  });

  byId('fees-list').addEventListener('click', async (event) => {
    const approve = event.target.closest('[data-fee-approve]');
    if (approve) {
      const { error } = await sb.rpc('approve_fee_payment', { p_id: approve.dataset.feeApprove });
      if (error) { toast(`Could not approve: ${error.message}`); return; }
      toast('Approved. The store is verified for 30 more days');
      loadFees(); loadSellers();
      return;
    }
    const reject = event.target.closest('[data-fee-reject]');
    if (reject) {
      if (!window.confirm('Reject this payment?')) return;
      const { error } = await sb.rpc('reject_fee_payment', { p_id: reject.dataset.feeReject });
      if (error) { toast(`Could not reject: ${error.message}`); return; }
      toast('Payment rejected. The slip is deleted');
      loadFees().then(forgetSlips);
      return;
    }
    const slip = event.target.closest('[data-fee-slip]');
    if (slip) {
      const payment = feePayments.find((p) => p.id === slip.dataset.feeSlip);
      if (!payment || !payment.receipt_path) return;
      const popup = window.open('', '_blank');
      const { data, error } = await sb.storage.from('receipts').createSignedUrl(payment.receipt_path, 300);
      if (error || !data) { if (popup) popup.close(); toast('Could not open the slip.'); return; }
      if (popup) popup.location.href = data.signedUrl; else window.location.href = data.signedUrl;
    }
  });

  /* The monthly fee amount, and whether unpaid stores are hidden. */
  const feeSettingsForm = byId('fee-settings-form');

  async function loadFeeSettings() {
    const { data } = await sb.from('site_settings').select('*').maybeSingle();
    if (!data) return;
    feeSettingsForm.elements.monthlyFee.value = data.monthly_fee;
    feeSettingsForm.elements.feeRequired.checked = !!data.fee_required;
  }

  feeSettingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = feeSettingsForm.elements;
    byId('fee-settings-error').hidden = true;
    const amount = Number(f.monthlyFee.value);
    if (!Number.isInteger(amount) || amount < 1) { showFieldError(f.monthlyFee, 'Enter the fee in whole rupees.'); return; }
    showFieldError(f.monthlyFee, '');
    const { error } = await sb.from('site_settings').update({ monthly_fee: amount, fee_required: f.feeRequired.checked }).eq('id', true);
    if (error) { byId('fee-settings-error').textContent = error.message; byId('fee-settings-error').hidden = false; return; }
    toast('Fee settings saved');
  });

  /* ---------- Brand logos: uploaded once here, picked by every seller ---------- */
  const BRAND_BUCKET = 'product-images';
  const brandUrl = (path) => sb.storage.from(BRAND_BUCKET).getPublicUrl(path).data.publicUrl;
  let brands = [];

  function shrinkImage(file, maxSide = 600) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read that image.'))), 'image/jpeg', 0.9);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a usable image.')); };
      img.src = url;
    });
  }

  function renderBrands() {
    byId('brand-list').innerHTML = brands.map((b) => `
      <figure class="brand-item">
        <img src="${esc(brandUrl(b.path))}" alt="" loading="lazy">
        <span>${esc(b.name)}</span>
        <button class="icon-btn icon-btn--sm" type="button" data-delete-brand="${esc(b.id)}" aria-label="Delete ${esc(b.name)}">${icon('i-trash')}</button>
      </figure>`).join('');
  }

  async function loadBrands() {
    const { data } = await sb.from('brand_logos').select('*').order('name');
    brands = data || [];
    renderBrands();
  }

  byId('brand-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = byId('brand-form').elements;
    const name = f.brandName.value.trim();
    const file = f.brandFile.files[0];
    const error = byId('brand-error');
    error.hidden = true;
    if (!name) { error.textContent = 'Enter the brand name.'; error.hidden = false; return; }
    if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) { error.textContent = 'Choose a JPG, PNG or WebP logo image.'; error.hidden = false; return; }
    const button = byId('brand-form').querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const blob = await shrinkImage(file);
      const path = `brands/${Date.now()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}.jpg`;
      const { error: uploadError } = await sb.storage.from(BRAND_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
      if (uploadError) throw uploadError;
      const { data, error: insertError } = await sb.from('brand_logos').insert({ name, path }).select().maybeSingle();
      if (insertError) { sb.storage.from(BRAND_BUCKET).remove([path]).catch(() => {}); throw insertError; }
      brands.push(data);
      brands.sort((a, b) => a.name.localeCompare(b.name));
      renderBrands();
      byId('brand-form').reset();
      toast('Logo added');
    } catch (err) {
      error.textContent = (err && err.message) || 'Could not add the logo.';
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  byId('brand-list').addEventListener('click', async (event) => {
    const del = event.target.closest('[data-delete-brand]');
    if (!del) return;
    const brand = brands.find((b) => b.id === del.dataset.deleteBrand);
    if (!brand || !window.confirm(`Remove the ${brand.name} logo? Products that already use it will lose their logo.`)) return;
    const { error } = await sb.from('brand_logos').delete().eq('id', brand.id);
    if (error) { toast(`Could not remove: ${error.message}`); return; }
    sb.storage.from(BRAND_BUCKET).remove([brand.path]).catch(() => {});
    brands = brands.filter((b) => b.id !== brand.id);
    renderBrands();
    toast('Logo removed');
  });

  /* ---------- Ads: a store (and an optional poster) that pops up when customers open the shop ----------
     Three parts: Requests (a seller buys an ad in their dashboard and sends a slip), Ads (every ad; the owner
     can also add one by hand) and Packages (what sellers can buy, and the owner's Telegram shown to them). */
  let ads = [];
  let spotRequests = [];
  let spotPacks = [];

  function showSpotTab(name) {
    byId('spot-tabs').querySelectorAll('[data-spottab]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.spottab === name)));
    ['requests', 'ads', 'packages'].forEach((part) => { byId(`spot-tab-${part}`).hidden = part !== name; });
  }

  byId('spot-tabs').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-spottab]');
    if (chip) showSpotTab(chip.dataset.spottab);
  });

  const pad2 = (n) => String(n).padStart(2, '0');
  /* datetime-local inputs hold the device's own time, like "2026-10-16T09:30" */
  const localInput = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const hoursFromNow = (hours) => localInput(new Date(Date.now() + hours * 3600000));
  const rs = (n) => esc(M.dual(n, 'LKR'));

  function formatDateTime(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  }

  /* 72 hours reads "3 days", 36 hours stays "36 hours" */
  function spanText(hours) {
    if (hours % 24 === 0) return `${hours / 24} ${plural(hours / 24, 'day', 'days')}`;
    return `${hours} ${plural(hours, 'hour', 'hours')}`;
  }

  function paintSpotCount() {
    const running = ads.filter((a) => adState(a).label === 'Running').length;
    const waiting = spotRequests.filter((r) => r.status === 'awaiting_review').length;
    byId('spots-count').textContent = `${ads.length} ${plural(ads.length, 'ad', 'ads')} · ${running} running${waiting ? ` · ${waiting} waiting` : ''}`;
    byId('spot-tabs').querySelector('[data-spottab="requests"]').textContent = waiting ? `Requests (${waiting})` : 'Requests';
  }

  function fillAdForm() {
    const f = byId('spot-form').elements;
    const live = sellers.filter((s) => s.status === 'approved')
      .sort((a, b) => String(a.store_name).localeCompare(String(b.store_name), undefined, { sensitivity: 'base' }));
    const chosen = f.store.value;
    f.store.innerHTML = live.length
      ? `<option value="">Choose a store</option>${live.map((s) => `<option value="${esc(s.id)}">${esc(s.store_name)}${s.store_slug ? ` (/${esc(s.store_slug)})` : ''}</option>`).join('')}`
      : '<option value="">No approved stores yet</option>';
    if (live.some((s) => s.id === chosen)) f.store.value = chosen;
    if (!f.startsAt.value) f.startsAt.value = hoursFromNow(0);
    if (!f.endsAt.value) f.endsAt.value = hoursFromNow(24 * 7);
  }

  function adState(a) {
    const now = Date.now();
    if (!a.active) return { label: 'Paused', tone: 'pending' };
    if (new Date(a.ends_at).getTime() <= now) return { label: 'Ended', tone: 'suspended' };
    if (new Date(a.starts_at).getTime() > now) return { label: 'Starts later', tone: 'pending' };
    return { label: 'Running', tone: 'approved' };
  }

  function adRow(a) {
    const store = sellers.find((s) => s.id === a.seller_id);
    const state = adState(a);
    const picture = a.image || (store && store.logo);
    const toggle = a.active
      ? `<button class="btn btn--ghost btn--sm" type="button" data-spot-pause="${esc(a.id)}">${icon('i-pause')}<span>Pause</span></button>`
      : `<button class="btn btn--ink btn--sm" type="button" data-spot-run="${esc(a.id)}">${icon('i-play')}<span>Run</span></button>`;
    return `
      <article class="seller-row" style="--h:${Number(store && store.hue) || 0}">
        <div class="seller-row__main">
          <span class="seller-row__avatar">${picture ? `<img src="${esc(brandUrl(picture))}" alt="" loading="lazy">` : icon('i-megaphone')}</span>
          <div class="seller-row__text">
            <p class="seller-row__name">${esc(a.title || (store ? store.store_name : 'Deleted store'))} <span class="status-badge status-badge--${state.tone}">${state.label}</span></p>
            <p class="seller-row__meta">${a.title && store ? `${esc(store.store_name)} &middot; ` : ''}${store && store.status !== 'approved' ? 'store not approved now &middot; ' : ''}${esc(formatDateTime(a.starts_at))} to ${esc(formatDateTime(a.ends_at))}${a.image ? ' &middot; own poster' : ''}${a.note ? ` &middot; ${esc(a.note)}` : ''}</p>
          </div>
        </div>
        <div class="seller-row__actions">
          <button class="btn btn--ghost btn--sm" type="button" data-spot-edit="${esc(a.id)}">${icon('i-edit')}<span>Edit</span></button>
          ${toggle}
          <button class="btn btn--ghost btn--sm" type="button" data-spot-delete="${esc(a.id)}">${icon('i-trash')}<span>Delete</span></button>
        </div>
      </article>`;
  }

  function renderAds() {
    byId('spots-list').innerHTML = ads.map(adRow).join('');
    byId('spots-list').hidden = ads.length === 0;
    byId('spots-empty').hidden = ads.length > 0;
    paintSpotCount();
    if (spotRequests.length) renderSpotRequests(); /* approved requests show when their ad ends */
  }

  async function loadAds() {
    fillAdForm();
    const { data, error } = await sb.from('spotlights').select('*').order('created_at', { ascending: false });
    if (error) {
      toast(`Could not load ads: ${error.message}`);
      return;
    }
    ads = data || [];
    renderAds();
  }

  /* The form adds a new ad, or saves an existing one after its Edit button was used. */
  let editingAd = null;

  function resetAdForm() {
    const form = byId('spot-form');
    editingAd = null;
    form.reset();
    byId('spot-error').hidden = true;
    byId('spot-submit').textContent = 'Add ad';
    byId('spot-cancel').hidden = true;
    fillAdForm();
  }

  function startAdEdit(ad) {
    const f = byId('spot-form').elements;
    fillAdForm();
    if (![...f.store.options].some((o) => o.value === ad.seller_id)) {
      const s = sellers.find((row) => row.id === ad.seller_id);
      f.store.insertAdjacentHTML('beforeend', `<option value="${esc(ad.seller_id)}">${esc(s ? s.store_name : 'Deleted store')} (not approved now)</option>`);
    }
    editingAd = ad;
    f.store.value = ad.seller_id;
    f.poster.value = '';
    f.startsAt.value = localInput(new Date(ad.starts_at));
    f.endsAt.value = localInput(new Date(ad.ends_at));
    f.title.value = ad.title || '';
    f.message.value = ad.message || '';
    f.note.value = ad.note || '';
    byId('spot-error').hidden = true;
    byId('spot-submit').textContent = 'Save changes';
    byId('spot-cancel').hidden = false;
    byId('spot-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  byId('spot-cancel').addEventListener('click', resetAdForm);

  byId('spot-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = byId('spot-form');
    const f = form.elements;
    const error = byId('spot-error');
    const fail = (message) => { error.textContent = message; error.hidden = false; };
    error.hidden = true;
    const file = f.poster.files[0];
    const startsAt = new Date(f.startsAt.value);
    const endsAt = new Date(f.endsAt.value);
    if (!f.store.value) return fail('Choose the store to promote.');
    if (file && !/^image\/(jpeg|png|webp)$/.test(file.type)) return fail('The poster must be a JPG, PNG or WebP image.');
    if (!f.startsAt.value || !f.endsAt.value || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return fail('Choose when the ad starts and ends.');
    if (endsAt <= startsAt) return fail('The end must be after the start.');

    const editing = editingAd;
    const button = byId('spot-submit');
    button.disabled = true;
    let path = null;
    try {
      if (file) {
        const blob = await shrinkImage(file, 1200);
        path = `spotlight/${Date.now()}.jpg`; /* not "ads/": ad blockers hide pictures from such folders */
        const { error: uploadError } = await sb.storage.from(BRAND_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
        if (uploadError) throw uploadError;
      }
      const fields = {
        seller_id: f.store.value,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        title: f.title.value.trim(),
        message: f.message.value.trim(),
        note: f.note.value.trim()
      };
      if (editing) {
        if (path) fields.image = path; /* no new file: keep the current poster */
        const { data, error: updateError } = await sb.from('spotlights').update(fields).eq('id', editing.id).select().maybeSingle();
        if (updateError) throw updateError;
        if (!data) throw new Error('This ad no longer exists. Reload the page.');
        if (path && editing.image) sb.storage.from(BRAND_BUCKET).remove([editing.image]).catch(() => {});
        ads = ads.map((a) => (a.id === data.id ? data : a));
        renderAds();
        resetAdForm();
        toast('Ad saved');
      } else {
        const { data, error: insertError } = await sb.from('spotlights').insert({ ...fields, image: path }).select().maybeSingle();
        if (insertError) throw insertError;
        ads.unshift(data);
        renderAds();
        resetAdForm();
        toast('Ad added');
      }
    } catch (err) {
      if (path) sb.storage.from(BRAND_BUCKET).remove([path]).catch(() => {});
      fail((err && err.message) || 'Could not save the ad.');
    } finally {
      button.disabled = false;
    }
  });

  byId('spots-list').addEventListener('click', async (event) => {
    const pause = event.target.closest('[data-spot-pause]');
    const run = event.target.closest('[data-spot-run]');
    const del = event.target.closest('[data-spot-delete]');
    const edit = event.target.closest('[data-spot-edit]');
    const id = (pause && pause.dataset.spotPause) || (run && run.dataset.spotRun) || (del && del.dataset.spotDelete) || (edit && edit.dataset.spotEdit);
    const ad = ads.find((a) => a.id === id);
    if (!ad) return;
    if (edit) { startAdEdit(ad); return; }
    if (del) {
      if (!window.confirm('Delete this ad? It stops showing in the shop.')) return;
      const { error } = await sb.from('spotlights').delete().eq('id', ad.id);
      if (error) { toast(`Could not delete: ${error.message}`); return; }
      if (ad.image) sb.storage.from(BRAND_BUCKET).remove([ad.image]).catch(() => {});
      ads = ads.filter((a) => a.id !== ad.id);
      if (editingAd && editingAd.id === ad.id) resetAdForm();
      renderAds();
      toast('Ad deleted');
      return;
    }
    const active = Boolean(run);
    const { error } = await sb.from('spotlights').update({ active }).eq('id', ad.id);
    if (error) { toast(`Could not save: ${error.message}`); return; }
    ad.active = active;
    renderAds();
    toast(active ? 'Ad running' : 'Ad paused');
  });

  /* Requests: a seller filled in the popup, picked a package and sent a payment slip. Approving creates the ad. */
  const REQUEST_BADGE = { awaiting_review: ['pending', 'Waiting for review'], approved: ['approved', 'Approved'], rejected: ['suspended', 'Not accepted'] };

  async function loadSpotRequests() {
    const { data, error } = await sb.from('spotlight_requests').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) { toast(`Could not load ad requests: ${error.message}`); return; }
    spotRequests = data || [];
    renderSpotRequests();
  }

  function spotRequestRow(r) {
    const [tone, label] = REQUEST_BADGE[r.status] || ['pending', r.status];
    const store = sellers.find((s) => s.id === r.seller_id);
    const picture = r.image || (store && store.logo);
    const ad = r.spotlight_id && ads.find((a) => a.id === r.spotlight_id);
    const length = r.qty > 1 ? `${r.qty} × ${spanText(r.hours)} = ${spanText(r.hours * r.qty)}` : spanText(r.hours);
    const actions = [];
    if (r.image) actions.push(`<a class="btn btn--ghost btn--sm" href="${esc(brandUrl(r.image))}" target="_blank" rel="noopener"><span>Poster</span></a>`);
    if (r.receipt_path) actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-spotreq-slip="${esc(r.id)}"><span>View slip</span></button>`);
    if (r.status === 'awaiting_review') {
      actions.push(`<button class="btn btn--ink btn--sm" type="button" data-spotreq-approve="${esc(r.id)}">${icon('i-check')}<span>Approve</span></button>`);
      actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-spotreq-reject="${esc(r.id)}">${icon('i-pause')}<span>Reject</span></button>`);
    }
    return `
      <article class="seller-row" style="--h:${Number(store && store.hue) || 0}">
        <div class="seller-row__main">
          <span class="seller-row__avatar">${picture ? `<img src="${esc(brandUrl(picture))}" alt="" loading="lazy">` : icon('i-megaphone')}</span>
          <div class="seller-row__text">
            <p class="seller-row__name">${esc(store ? store.store_name : 'Deleted store')} <span class="status-badge status-badge--${tone}">${esc(label)}</span></p>
            <p class="seller-row__meta">${esc(length)} &middot; ${rs(r.amount_lkr)} &middot; sent ${esc(formatDateTime(r.created_at))}${r.reference ? ` &middot; Reference: ${esc(r.reference)}` : ''}${ad ? ` &middot; runs ${esc(formatDateTime(ad.starts_at))} to ${esc(formatDateTime(ad.ends_at))}` : ''}</p>
            ${r.title || r.message ? `<p class="seller-row__meta spot-request__text">${r.title ? `<strong>${esc(r.title)}</strong>` : ''}${r.title && r.message ? ' &middot; ' : ''}${esc(r.message)}</p>` : ''}
          </div>
        </div>
        <div class="seller-row__actions">${actions.join('')}</div>
      </article>`;
  }

  function renderSpotRequests() {
    const waitingFirst = (r) => (r.status === 'awaiting_review' ? 0 : 1);
    const list = spotRequests.slice().sort((a, b) => waitingFirst(a) - waitingFirst(b) || String(b.created_at).localeCompare(String(a.created_at)));
    byId('spot-requests-list').innerHTML = list.map(spotRequestRow).join('');
    byId('spot-requests-list').hidden = list.length === 0;
    byId('spot-requests-empty').hidden = list.length > 0;
    paintSpotCount();
  }

  byId('spot-requests-list').addEventListener('click', async (event) => {
    const approve = event.target.closest('[data-spotreq-approve]');
    if (approve) {
      approve.disabled = true;
      const { data, error } = await sb.rpc('approve_spotlight_request', { p_id: approve.dataset.spotreqApprove });
      if (error) { approve.disabled = false; toast(`Could not approve: ${error.message}`); loadSpotRequests(); return; }
      toast(`Approved. The ad runs until ${formatDateTime(data)}`);
      await loadAds();
      loadSpotRequests();
      return;
    }
    const reject = event.target.closest('[data-spotreq-reject]');
    if (reject) {
      const request = spotRequests.find((r) => r.id === reject.dataset.spotreqReject);
      if (!request) return;
      if (!window.confirm('Reject this request? If the seller paid, send the money back to them yourself.')) return;
      const { error } = await sb.rpc('reject_spotlight_request', { p_id: request.id });
      if (error) { toast(`Could not reject: ${error.message}`); loadSpotRequests(); return; }
      if (request.image) sb.storage.from(BRAND_BUCKET).remove([request.image]).catch(() => {});
      toast('Request rejected. The slip is deleted');
      loadSpotRequests().then(forgetSlips);
      return;
    }
    const slip = event.target.closest('[data-spotreq-slip]');
    if (slip) {
      const request = spotRequests.find((r) => r.id === slip.dataset.spotreqSlip);
      if (!request || !request.receipt_path) return;
      const popup = window.open('', '_blank');
      const { data, error } = await sb.storage.from('receipts').createSignedUrl(request.receipt_path, 300);
      if (error || !data) { if (popup) popup.close(); toast('Could not open the slip.'); return; }
      if (popup) popup.location.href = data.signedUrl; else window.location.href = data.signedUrl;
    }
  });

  /* Packages: what sellers can buy, shown to them as the same glass boxes. */
  const packForm = byId('spot-pack-form');
  let editingPack = null;

  async function loadSpotPacks() {
    const { data, error } = await sb.from('spotlight_packages').select('*').order('hours').order('price');
    if (error) { toast(`Could not load ad packages: ${error.message}`); return; }
    spotPacks = data || [];
    renderSpotPacks();
  }

  function packBox(p) {
    const length = spanText(p.hours);
    const editing = editingPack && editingPack.id === p.id;
    return `
      <div class="spot-pack spot-pack--admin${p.active ? '' : ' is-off'}${editing ? ' is-editing' : ''}">
        <p class="spot-pack__time">${esc(length)}</p>
        <p class="spot-pack__price">${rs(p.price)}</p>
        <p class="spot-pack__note">${p.max_qty > 1 ? `Up to ${p.max_qty} at once (${esc(spanText(p.hours * p.max_qty))})` : 'One at a time'}${p.active ? '' : '<br>Hidden from sellers'}</p>
        <div class="spot-pack__tools">
          <button class="btn btn--ghost btn--sm" type="button" data-pack-edit="${esc(p.id)}" title="Edit" aria-label="Edit the ${esc(length)} package">${icon('i-edit')}</button>
          <button class="btn btn--ghost btn--sm" type="button" data-pack-toggle="${esc(p.id)}" title="${p.active ? 'Hide from sellers' : 'Show to sellers'}" aria-label="${p.active ? 'Hide' : 'Show'} the ${esc(length)} package">${icon(p.active ? 'i-pause' : 'i-play')}</button>
          <button class="btn btn--ghost btn--sm" type="button" data-pack-delete="${esc(p.id)}" title="Delete" aria-label="Delete the ${esc(length)} package">${icon('i-trash')}</button>
        </div>
      </div>`;
  }

  function renderSpotPacks() {
    spotPacks.sort((a, b) => a.hours - b.hours || a.price - b.price);
    byId('spot-packs-admin').innerHTML = spotPacks.length
      ? spotPacks.map(packBox).join('')
      : '<p class="spot-packs__empty">No packages yet. Add one below: sellers cannot buy an ad until there is one.</p>';
  }

  function packHours() {
    const f = packForm.elements;
    const n = Number(f.span.value);
    if (!f.span.value || !Number.isInteger(n) || n < 1) return 0;
    return f.unit.value === 'days' ? n * 24 : n;
  }

  function paintPackPreview() {
    const f = packForm.elements;
    const hours = packHours();
    const price = Number(f.price.value);
    const max = Number(f.maxQty.value);
    const out = byId('spot-pack-preview');
    if (!hours || !Number.isInteger(price) || price < 1 || !Number.isInteger(max) || max < 1) { out.textContent = ''; return; }
    out.textContent = `Sellers see: ${spanText(hours)} for ${M.own(price, 'LKR')}${max > 1 ? `. They can take up to ${max}: ${spanText(hours * max)} for ${M.own(price * max, 'LKR')}.` : ', one at a time.'}`;
  }

  function resetPackForm() {
    editingPack = null;
    packForm.reset();
    byId('spot-pack-error').hidden = true;
    byId('spot-pack-form-title').textContent = 'Add a package';
    byId('spot-pack-submit').textContent = 'Add package';
    byId('spot-pack-cancel').hidden = true;
    paintPackPreview();
    renderSpotPacks();
  }

  function startPackEdit(p) {
    const f = packForm.elements;
    const inDays = p.hours % 24 === 0;
    editingPack = p;
    f.span.value = inDays ? p.hours / 24 : p.hours;
    f.unit.value = inDays ? 'days' : 'hours';
    f.price.value = p.price;
    f.maxQty.value = p.max_qty;
    byId('spot-pack-error').hidden = true;
    byId('spot-pack-form-title').textContent = 'Edit package';
    byId('spot-pack-submit').textContent = 'Save changes';
    byId('spot-pack-cancel').hidden = false;
    paintPackPreview();
    renderSpotPacks();
    packForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  packForm.addEventListener('input', paintPackPreview);
  byId('spot-pack-cancel').addEventListener('click', resetPackForm);

  packForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = packForm.elements;
    const error = byId('spot-pack-error');
    const fail = (message) => { error.textContent = message; error.hidden = false; };
    error.hidden = true;
    const hours = packHours();
    const price = Number(f.price.value);
    const maxQty = Number(f.maxQty.value);
    if (!hours) return fail('Enter how long, in whole hours or days.');
    if (hours > 8760) return fail('A package can be at most 365 days.');
    if (!f.price.value || !Number.isInteger(price) || price < 1) return fail('Enter the price in whole rupees.');
    if (price > 10000000) return fail('That price is too high.');
    if (!f.maxQty.value || !Number.isInteger(maxQty) || maxQty < 1 || maxQty > 365) return fail('The most a seller can buy at once must be 1 to 365.');

    const editing = editingPack;
    const button = byId('spot-pack-submit');
    button.disabled = true;
    const fields = { hours, price, max_qty: maxQty };
    const query = editing
      ? sb.from('spotlight_packages').update(fields).eq('id', editing.id)
      : sb.from('spotlight_packages').insert(fields);
    const { data, error: saveError } = await query.select().maybeSingle();
    button.disabled = false;
    if (saveError) return fail(saveError.message);
    if (!data) return fail('This package no longer exists. Reload the page.');
    spotPacks = editing ? spotPacks.map((p) => (p.id === data.id ? data : p)) : spotPacks.concat(data);
    resetPackForm();
    toast(editing ? 'Package saved' : 'Package added');
  });

  byId('spot-packs-admin').addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-pack-edit]');
    const toggle = event.target.closest('[data-pack-toggle]');
    const del = event.target.closest('[data-pack-delete]');
    const id = (edit && edit.dataset.packEdit) || (toggle && toggle.dataset.packToggle) || (del && del.dataset.packDelete);
    const pack = spotPacks.find((p) => p.id === id);
    if (!pack) return;
    if (edit) { startPackEdit(pack); return; }
    if (del) {
      if (!window.confirm(`Delete the ${spanText(pack.hours)} package? Requests already sent are not changed.`)) return;
      const { error } = await sb.from('spotlight_packages').delete().eq('id', pack.id);
      if (error) { toast(`Could not delete: ${error.message}`); return; }
      spotPacks = spotPacks.filter((p) => p.id !== pack.id);
      if (editingPack && editingPack.id === pack.id) resetPackForm(); else renderSpotPacks();
      toast('Package deleted');
      return;
    }
    const active = !pack.active;
    const { error } = await sb.from('spotlight_packages').update({ active }).eq('id', pack.id);
    if (error) { toast(`Could not save: ${error.message}`); return; }
    pack.active = active;
    renderSpotPacks();
    toast(active ? 'Sellers can buy this package again' : 'Package hidden from sellers');
  });

  /* The owner's Telegram username: sellers get a "Message on Telegram" button in their Ads page. */
  const telegramForm = byId('spot-telegram-form');

  async function loadOwnerTelegram() {
    const { data } = await sb.from('site_settings').select('owner_telegram').maybeSingle();
    if (data) telegramForm.elements.username.value = data.owner_telegram ? `@${data.owner_telegram}` : '';
  }

  telegramForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = telegramForm.elements.username;
    /* People paste "@name" or a "t.me/name" link; the database keeps only "name" */
    const name = input.value.trim().replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i, '').replace(/^@/, '').replace(/\/+$/, '');
    if (name && !/^[A-Za-z0-9_]{5,32}$/.test(name)) {
      showFieldError(input, 'A Telegram username has 5 to 32 letters, numbers or underscores (_).');
      return;
    }
    showFieldError(input, '');
    const button = telegramForm.querySelector('button[type="submit"]');
    button.disabled = true;
    const { error } = await sb.from('site_settings').update({ owner_telegram: name }).eq('id', true);
    button.disabled = false;
    if (error) { showFieldError(input, error.message); return; }
    input.value = name ? `@${name}` : '';
    toast(name ? 'Telegram username saved' : 'Telegram button hidden from sellers');
  });

  telegramForm.addEventListener('input', (event) => {
    if (event.target.getAttribute('aria-invalid') === 'true') showFieldError(event.target, '');
  });

  document.title = `Admin | ${CFG.storeName}`;
})();
