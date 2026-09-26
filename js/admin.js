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
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname }
    });
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
  }

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
      loadOrders();
      loadOwnerBank();
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
            <p class="seller-row__meta">${esc(s.email)} &middot; /store/${esc(s.store_slug)} &middot; joined ${formatDate(s.created_at)} &middot; free until ${formatDate(s.free_until)}</p>
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
    byId('section-tabs').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    byId('sellers-section').hidden = chip.dataset.section !== 'sellers';
    byId('products-section').hidden = chip.dataset.section !== 'products';
    byId('orders-section').hidden = chip.dataset.section !== 'orders';
    byId('settings-section').hidden = chip.dataset.section !== 'settings';
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
            <p class="seller-row__meta">${esc(store ? store.store_name : 'Unknown store')} &middot; ${esc(p.category)} &middot; Rs. ${Number(p.price).toLocaleString('en-US')}${p.type ? ` &middot; ${esc(p.type)}` : ''}</p>
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
    const amount = o.method === 'paypal' && o.amount_usd ? `$${Number(o.amount_usd).toFixed(2)} via PayPal` : `Rs. ${Number(o.amount_lkr).toLocaleString('en-US')} by bank transfer`;
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
    toast('Order rejected');
    loadOrders();
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

  document.title = `Admin | ${CFG.storeName}`;
})();
