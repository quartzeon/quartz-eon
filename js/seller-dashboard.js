/* Quartz Eon: seller dashboard. Log in with the same email and password used to sign up.
   Not linked from the public site's nav — reached by typing seller.html in the browser (the
   account menu will link to it once someone is signed in as a seller, in a later piece). */
(function () {
  'use strict';

  const CFG = Object.assign({ storeName: 'Quartz Eon', sellerMonthlyFee: 500, categories: [] }, window.QE_CONFIG);
  const sb = window.QE_SUPABASE;
  const root = document.documentElement;
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  const byId = (id) => document.getElementById(id);
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  const icon = (id) => `<svg class="i" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
  const art = (name) => `<svg class="art" aria-hidden="true" focusable="false"><use href="#a-${esc(name)}"/></svg>`;
  const plural = (n, one, many) => (n === 1 ? one : many);
  const storage = { set(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } } };

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

  /* ---------- Toasts ---------- */
  let toastTimer = 0;
  function toast(message) {
    const box = byId('seller-toasts');
    box.innerHTML = `<div class="toast"><span>${esc(message)}</span></div>`;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { box.innerHTML = ''; }, 3200);
  }

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

  /* ---------- Log in ---------- */
  const loginForm = byId('seller-login-form');

  loginForm.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-pw-toggle]');
    if (!toggle) return;
    const input = byId(toggle.dataset.pwToggle);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
  });

  loginForm.addEventListener('input', (event) => {
    if (event.target.getAttribute('aria-invalid') === 'true') showFieldError(event.target, '');
  });

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = loginForm.elements.email.value.trim();
    const password = loginForm.elements.password.value;
    byId('seller-form-error').hidden = true;
    if (!email) showFieldError(loginForm.elements.email, 'Enter your email.');
    if (!password) showFieldError(loginForm.elements.password, 'Enter your password.');
    if (!email || !password) return;

    const submitButton = loginForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = 'Please wait…';
    const { error } = await sb.auth.signInWithPassword({ email, password });
    submitButton.disabled = false;
    submitButton.textContent = 'Log in';
    if (error) {
      const note = byId('seller-form-error');
      note.textContent = friendlyAuthError(error);
      note.hidden = false;
    }
    /* Success is picked up by onAuthStateChange, below. */
  });

  byId('seller-logout').addEventListener('click', () => sb.auth.signOut());

  /* ---------- Which panel is showing ---------- */
  function showPanel(name, email) {
    byId('seller-login').hidden = name !== 'login';
    byId('seller-denied').hidden = name !== 'denied';
    byId('seller-app').hidden = name !== 'app';
    byId('seller-logout').hidden = name === 'login';
    if (name === 'denied') byId('seller-denied-email').textContent = email || '';
  }

  let sellerRow = null;

  sb.auth.onAuthStateChange(async (event, session) => {
    if (!session) {
      showPanel('login');
      return;
    }
    const { data: profile } = await sb.from('profiles').select('role').eq('id', session.user.id).maybeSingle();
    if (!profile || profile.role !== 'seller') {
      showPanel('denied', session.user.email);
      return;
    }
    const { data: row } = await sb.from('sellers').select('*').eq('id', session.user.id).maybeSingle();
    if (!row) {
      showPanel('denied', session.user.email);
      return;
    }
    sellerRow = row;
    showPanel('app');
    fillStoreForm();
    loadVpnConfig();
    loadSales();
    loadBank();
    loadTelegram();
    loadOwnerBank();
  });

  /* ---------- Status banner ---------- */
  function formatDate(value) {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function renderStatusBanner() {
    const s = sellerRow;
    const badge = `<span class="status-badge status-badge--${s.status}">${s.status}</span>`;
    let text;
    if (s.status === 'pending') text = `Your store is waiting for approval. You can still set up your store and add products now — they will go live once approved.`;
    else if (s.status === 'suspended') text = `Your store is hidden from customers. Contact the site owner to reactivate it.`;
    else text = `Your store is live. Store fee: ${CFG.sellerMonthlyFee ? `Rs. ${CFG.sellerMonthlyFee} / month` : '—'}. Free until ${formatDate(s.free_until)}.`;
    byId('status-banner').innerHTML = `${badge}<p>${text}${s.status === 'approved' ? ` <a href="index.html#/store/${esc(s.store_slug)}" target="_blank" rel="noopener">View your store &rarr;</a>` : ''}</p>`;
  }

  /* ---------- Store profile ---------- */
  const storeForm = byId('store-form');

  /* ---------- Store logo: uploaded straight away, shown next to the store name in the shop ---------- */
  const LOGO_BUCKET = 'product-images';
  const logoUrl = (path) => sb.storage.from(LOGO_BUCKET).getPublicUrl(path).data.publicUrl;

  function renderStoreLogo() {
    byId('store-logo').innerHTML = sellerRow.logo
      ? `<figure class="pp-photo pp-photo--logo"><img src="${esc(logoUrl(sellerRow.logo))}" alt="Store logo"><button class="pp-photo__btn pp-photo__btn--x" type="button" data-remove-store-logo aria-label="Remove the logo" title="Remove">${icon('i-close')}</button></figure>`
      : '';
    byId('store-logo-label').textContent = sellerRow.logo ? 'Change the logo' : 'Upload a logo';
  }

  /* A logo is shrunk to 600 pixels on a white background (JPEG has no transparency). */
  function shrinkLogo(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, 600 / Math.max(img.width, img.height));
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

  async function saveStoreLogo(path) {
    const previous = sellerRow.logo;
    const { error } = await sb.from('sellers').update({ logo: path }).eq('id', sellerRow.id);
    if (error) return error;
    sellerRow.logo = path;
    if (previous) sb.storage.from(LOGO_BUCKET).remove([previous]).catch(() => {});
    renderStoreLogo();
    return null;
  }

  byId('store-logo-input').addEventListener('change', async (event) => {
    const file = (event.target.files || [])[0];
    event.target.value = '';
    const errorBox = byId('store-logo-error');
    errorBox.hidden = true;
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { errorBox.textContent = 'Use a JPG, PNG or WebP image.'; errorBox.hidden = false; return; }
    try {
      const blob = await shrinkLogo(file);
      const path = `${sellerRow.id}/store-logo-${Date.now()}.jpg`;
      const { error: uploadError } = await sb.storage.from(LOGO_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
      if (uploadError) throw uploadError;
      const saveError = await saveStoreLogo(path);
      if (saveError) { sb.storage.from(LOGO_BUCKET).remove([path]).catch(() => {}); throw saveError; }
      toast('Store logo saved');
    } catch (err) {
      errorBox.textContent = (err && err.message) || 'Could not save the logo.';
      errorBox.hidden = false;
    }
  });

  byId('store-logo').addEventListener('click', async (event) => {
    if (!event.target.closest('[data-remove-store-logo]')) return;
    const error = await saveStoreLogo(null);
    if (error) toast(`Could not remove the logo: ${error.message}`);
    else toast('Store logo removed');
  });

  function fillStoreForm() {
    storeForm.elements.storeName.value = sellerRow.store_name;
    storeForm.elements.about.value = sellerRow.about || '';
    byId('store-link').value = `${window.location.origin}${window.location.pathname.replace('seller.html', '')}index.html#/store/${sellerRow.store_slug}`;
    storeForm.elements.whatsapp.value = sellerRow.contact_whatsapp || '';
    storeForm.elements.telegram.value = sellerRow.contact_telegram || '';
    storeForm.elements.facebook.value = sellerRow.social_facebook || '';
    storeForm.elements.instagram.value = sellerRow.social_instagram || '';
    storeForm.elements.website.value = sellerRow.social_website || '';
    renderStoreLogo();
    renderStatusBanner();
  }

  byId('copy-link').addEventListener('click', async () => {
    const field = byId('store-link');
    try {
      await navigator.clipboard.writeText(field.value);
    } catch (e) {
      field.select();
      try { document.execCommand('copy'); } catch (e2) { /* nothing more to try */ }
    }
    toast('Store link copied');
  });

  storeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    byId('store-form-error').hidden = true;
    const storeName = storeForm.elements.storeName.value.trim();
    if (storeName.length < 3 || storeName.length > 40) {
      showFieldError(storeForm.elements.storeName, 'Enter a store name of 3 to 40 characters.');
      return;
    }
    const about = storeForm.elements.about.value.trim();
    const f = storeForm.elements;
    let ok = true;

    /* WhatsApp: digits with the country code. A Sri Lankan number written 0771234567 becomes 94771234567. */
    let whatsapp = f.whatsapp.value.replace(/[^0-9]/g, '');
    if (/^0\d{9}$/.test(whatsapp)) whatsapp = `94${whatsapp.slice(1)}`;
    if (whatsapp && !/^\d{9,15}$/.test(whatsapp)) { showFieldError(f.whatsapp, 'Enter the number with the country code, for example 94771234567.'); ok = false; }
    /* Telegram: just the username, even if a link or an @ was pasted. */
    const telegram = f.telegram.value.trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@/, '').replace(/[/?].*$/, '');
    if (telegram && !/^[A-Za-z0-9_]{5,32}$/.test(telegram)) { showFieldError(f.telegram, 'Use 5 to 32 letters, numbers or underscores.'); ok = false; }
    const link = (input, pattern, message) => {
      const value = input.value.trim();
      if (value && (value.length > 200 || !pattern.test(value))) { showFieldError(input, message); ok = false; }
      return value;
    };
    const facebook = link(f.facebook, /^https:\/\/([a-z0-9-]+\.)*(facebook\.com|fb\.com|fb\.me)\/\S*$/i, 'Use a link that starts with https:// and is on facebook.com.');
    const instagram = link(f.instagram, /^https:\/\/([a-z0-9-]+\.)*instagram\.com\/\S*$/i, 'Use a link that starts with https:// and is on instagram.com.');
    const website = link(f.website, /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i, 'Use a link that starts with https://');
    if (!ok) return;

    const details = {
      store_name: storeName,
      about,
      contact_whatsapp: whatsapp || null,
      contact_telegram: telegram || null,
      social_facebook: facebook || null,
      social_instagram: instagram || null,
      social_website: website || null
    };
    const submitButton = storeForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    const { error } = await sb.from('sellers').update(details).eq('id', sellerRow.id);
    submitButton.disabled = false;
    if (error) {
      byId('store-form-error').textContent = error.message;
      byId('store-form-error').hidden = false;
      return;
    }
    Object.assign(sellerRow, details);
    f.whatsapp.value = whatsapp;
    f.telegram.value = telegram;
    toast('Store details saved');
  });

  storeForm.addEventListener('input', (event) => {
    if (event.target.getAttribute && event.target.getAttribute('aria-invalid') === 'true') showFieldError(event.target, '');
  });

  /* ---------- VPN panel connection ---------- */
  const vpnForm = byId('vpn-form');

  vpnForm.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-pw-toggle]');
    if (!toggle) return;
    const input = byId(toggle.dataset.pwToggle);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
  });

  async function loadVpnConfig() {
    const { data } = await sb.from('seller_vpn_config').select('*').eq('seller_id', sellerRow.id).maybeSingle();
    if (data) {
      vpnForm.elements.panelUrl.value = data.panel_url;
      vpnForm.elements.apiToken.value = data.api_token;
      vpnForm.elements.inboundId.value = data.inbound_id || '';
      vpnForm.elements.subUrlBase.value = data.sub_url_base || '';
      byId('vpn-saved-note').hidden = false;
      byId('vpn-saved-note').textContent = `Saved. Last updated ${formatDate(data.updated_at)}.`;
    }
  }

  vpnForm.addEventListener('input', (event) => {
    if (event.target.getAttribute && event.target.getAttribute('aria-invalid') === 'true') showFieldError(event.target, '');
  });

  vpnForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    byId('vpn-form-error').hidden = true;
    const panelUrl = vpnForm.elements.panelUrl.value.trim();
    const apiToken = vpnForm.elements.apiToken.value.trim();
    let ok = true;
    if (!/^https?:\/\/.+/i.test(panelUrl)) { showFieldError(vpnForm.elements.panelUrl, 'Enter a full address, starting with http:// or https://'); ok = false; }
    if (!apiToken) { showFieldError(vpnForm.elements.apiToken, 'Enter your panel’s API token.'); ok = false; }
    if (!ok) return;

    const submitButton = vpnForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    const { error } = await sb.from('seller_vpn_config').upsert({
      seller_id: sellerRow.id,
      panel_url: panelUrl,
      api_token: apiToken,
      inbound_id: vpnForm.elements.inboundId.value.trim(),
      sub_url_base: vpnForm.elements.subUrlBase.value.trim()
    });
    submitButton.disabled = false;
    if (error) {
      byId('vpn-form-error').textContent = error.message;
      byId('vpn-form-error').hidden = false;
      return;
    }
    byId('vpn-saved-note').hidden = false;
    byId('vpn-saved-note').textContent = 'Saved just now.';
    toast('VPN panel settings saved');
  });

  /* ---------- Orders for this store: check the transfer, approve or reject ---------- */
  const SALE_STATUS = { awaiting_review: ['pending', 'Waiting for review'], paid: ['approved', 'Paid'], rejected: ['suspended', 'Not accepted'] };
  let sales = [];

  function saleRow(o) {
    const [badgeClass, label] = SALE_STATUS[o.status] || ['pending', o.status];
    const amount = o.method === 'paypal' && o.amount_usd ? `$${Number(o.amount_usd).toFixed(2)} via PayPal` : `Rs. ${Number(o.amount_lkr).toLocaleString('en-US')} by bank transfer`;
    const actions = [];
    if (o.status === 'awaiting_review') {
      if (o.receipt_path) actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-slip="${esc(o.id)}"><span>View slip</span></button>`);
      actions.push(`<button class="btn btn--ink btn--sm" type="button" data-order-approve="${esc(o.id)}">${icon('i-check')}<span>Approve</span></button>`);
      actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-order-reject="${esc(o.id)}">${icon('i-pause')}<span>Reject</span></button>`);
    } else if (o.status === 'paid' && o.is_vpn && !o.delivery) {
      actions.push(`<button class="btn btn--ink btn--sm" type="button" data-order-retry="${esc(o.id)}">${icon('i-play')}<span>Retry VPN delivery</span></button>`);
    }
    const reference = o.method === 'bank' && o.reference ? ` &middot; Reference: ${esc(o.reference)}` : '';
    const problem = o.delivery_error && !o.delivery ? `<p class="prod-row__meta order-problem">VPN delivery failed: ${esc(o.delivery_error)}</p>` : '';
    return `
      <article class="prod-row">
        <div class="prod-row__main">
          <div class="prod-row__text">
            <p class="prod-row__name">${esc(o.product_name)} <span class="status-badge status-badge--${badgeClass}">${esc(label)}</span></p>
            <p class="prod-row__meta">${amount} &middot; ${esc(formatDate(o.created_at))}${reference}</p>
            ${problem}
          </div>
        </div>
        <div class="prod-row__actions">${actions.join('')}</div>
      </article>`;
  }

  function renderSales() {
    byId('sales-list').innerHTML = sales.map(saleRow).join('');
    byId('sales-list').hidden = sales.length === 0;
    byId('sales-empty').hidden = sales.length > 0;
    const waiting = sales.filter((o) => o.status === 'awaiting_review').length;
    byId('sales-count').textContent = `${sales.length} ${plural(sales.length, 'order', 'orders')}${waiting ? ` · ${waiting} waiting` : ''}`;
  }

  async function loadSales() {
    const { data, error } = await sb.from('orders').select('*').eq('seller_id', sellerRow.id).order('created_at', { ascending: false }).limit(100);
    if (error) {
      toast(`Could not load orders: ${error.message}`);
      return;
    }
    sales = data || [];
    renderSales();
  }

  /* Asks the server to set up the VPN client. Returns an error message, or '' on success. */
  async function deliverVpn(orderId) {
    const { data, error } = await sb.functions.invoke('fulfill-order', { body: { order_id: orderId } });
    if (!error && data && data.ok) return '';
    let message = (data && data.error) || (error && error.message) || 'Could not set up the VPN client.';
    try { const body = await error.context.json(); if (body && body.error) message = body.error; } catch (e) { /* keep the message above */ }
    return message;
  }

  async function approveSale(id) {
    const { error } = await sb.rpc('approve_order', { p_order_id: id });
    if (error) { toast(`Could not approve: ${error.message}`); return; }
    const order = sales.find((o) => o.id === id);
    if (order && order.is_vpn) {
      const problem = await deliverVpn(id);
      toast(problem ? `Approved, but VPN delivery failed: ${problem}` : 'Approved. VPN access created for the customer');
    } else {
      toast('Approved. The customer can now see their purchase');
    }
    loadSales();
  }

  async function rejectSale(id) {
    const { error } = await sb.rpc('reject_order', { p_order_id: id });
    if (error) { toast(`Could not reject: ${error.message}`); return; }
    toast('Order rejected');
    loadSales();
  }

  async function retrySale(id) {
    const problem = await deliverVpn(id);
    toast(problem ? `Still failing: ${problem}` : 'VPN access created');
    loadSales();
  }

  async function viewSlip(id) {
    const order = sales.find((o) => o.id === id);
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

  byId('sales-list').addEventListener('click', (event) => {
    const t = event.target;
    const approve = t.closest('[data-order-approve]');
    if (approve) { approveSale(approve.dataset.orderApprove); return; }
    const reject = t.closest('[data-order-reject]');
    if (reject) { if (window.confirm('Reject this order? The customer will see it as not accepted.')) rejectSale(reject.dataset.orderReject); return; }
    const retry = t.closest('[data-order-retry]');
    if (retry) { retrySale(retry.dataset.orderRetry); return; }
    const slip = t.closest('[data-slip]');
    if (slip) viewSlip(slip.dataset.slip);
  });

  /* ---------- Your bank details (customers pay you directly) ---------- */
  const bankForm = byId('bank-form');

  async function loadBank() {
    const { data } = await sb.from('seller_bank_details').select('*').eq('seller_id', sellerRow.id).maybeSingle();
    if (!data) return;
    bankForm.elements.bankName.value = data.bank_name || '';
    bankForm.elements.branch.value = data.branch || '';
    bankForm.elements.accountName.value = data.account_name || '';
    bankForm.elements.accountNumber.value = data.account_number || '';
    bankForm.elements.note.value = data.note || '';
    byId('bank-saved-note').hidden = false;
    byId('bank-saved-note').textContent = `Saved. Last updated ${formatDate(data.updated_at)}.`;
  }

  bankForm.addEventListener('input', (event) => {
    if (event.target.getAttribute && event.target.getAttribute('aria-invalid') === 'true') showFieldError(event.target, '');
  });

  bankForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    byId('bank-form-error').hidden = true;
    const f = bankForm.elements;
    const accountName = f.accountName.value.trim();
    const accountNumber = f.accountNumber.value.trim();
    let ok = true;
    if (accountName.length < 2) { showFieldError(f.accountName, 'Enter the name on the account.'); ok = false; }
    if (accountNumber.length < 3) { showFieldError(f.accountNumber, 'Enter the account number.'); ok = false; }
    if (!ok) return;

    const submitButton = bankForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    const { error } = await sb.from('seller_bank_details').upsert({
      seller_id: sellerRow.id,
      bank_name: f.bankName.value.trim(),
      branch: f.branch.value.trim(),
      account_name: accountName,
      account_number: accountNumber,
      note: f.note.value.trim(),
      updated_at: new Date().toISOString()
    });
    submitButton.disabled = false;
    if (error) {
      byId('bank-form-error').textContent = error.message;
      byId('bank-form-error').hidden = false;
      return;
    }
    byId('bank-saved-note').hidden = false;
    byId('bank-saved-note').textContent = 'Saved just now.';
    toast('Bank details saved');
  });

  /* ---------- Telegram alerts ---------- */
  const telegramBot = CFG.telegramBot || '';
  let telegramPoll = 0;

  function paintTelegram(connected) {
    byId('telegram-status').textContent = connected
      ? 'Connected. You will get an alert here whenever a customer sends a bank transfer for one of your products.'
      : 'Not connected yet. Until you connect, new transfers are sent to the site owner instead.';
    byId('telegram-connect').hidden = connected;
    byId('telegram-disconnect').hidden = !connected;
    byId('telegram-open').hidden = true;
    byId('telegram-connect').textContent = 'Connect Telegram';
  }

  async function telegramConnected() {
    const { data } = await sb.from('seller_telegram').select('chat_id').eq('seller_id', sellerRow.id).maybeSingle();
    return !!(data && data.chat_id);
  }

  async function loadTelegram() {
    if (!telegramBot) {
      byId('telegram-card').hidden = true;
      return;
    }
    paintTelegram(await telegramConnected());
  }

  byId('telegram-connect').addEventListener('click', async () => {
    const button = byId('telegram-connect');
    byId('telegram-error').hidden = true;
    button.disabled = true;
    const { data: code, error } = await sb.rpc('create_telegram_link_code');
    button.disabled = false;
    if (error || !code) {
      byId('telegram-error').textContent = (error && error.message) || 'Could not start the connection. Please try again.';
      byId('telegram-error').hidden = false;
      return;
    }
    const link = byId('telegram-open');
    link.href = `https://t.me/${encodeURIComponent(telegramBot)}?start=${encodeURIComponent(code)}`;
    link.hidden = false;
    button.textContent = 'Get a new link';
    byId('telegram-status').textContent = 'Press the button, then press Start in Telegram. This page notices by itself when you are connected. The link works for 15 minutes.';

    /* Look every 3 seconds for up to 2 minutes until the bot reports the chat. */
    window.clearInterval(telegramPoll);
    let tries = 0;
    telegramPoll = window.setInterval(async () => {
      tries += 1;
      if (await telegramConnected()) {
        window.clearInterval(telegramPoll);
        paintTelegram(true);
        toast('Telegram connected');
      } else if (tries >= 40) {
        window.clearInterval(telegramPoll);
      }
    }, 3000);
  });

  byId('telegram-disconnect').addEventListener('click', async () => {
    const { error } = await sb.rpc('disconnect_telegram');
    if (error) { toast(`Could not disconnect: ${error.message}`); return; }
    paintTelegram(false);
    toast('Telegram disconnected');
  });

  /* ---------- The owner's bank details, to pay the monthly store fee ---------- */
  async function loadOwnerBank() {
    const { data } = await sb.rpc('get_owner_bank');
    const bank = Array.isArray(data) ? data[0] : null;
    if (!bank || !bank.account_number) return;
    byId('fee-card').hidden = false;
    byId('fee-lead').textContent = CFG.sellerMonthlyFee
      ? `The store fee is Rs. ${Number(CFG.sellerMonthlyFee).toLocaleString('en-US')} per month. Pay it to this account and keep the slip.`
      : 'Pay the store fee to this account and keep the slip.';
    byId('fee-bank').innerHTML = [['Bank', bank.bank_name], ['Account name', bank.account_name], ['Account number', bank.account_number], ['Branch', bank.branch]]
      .filter((row) => row[1])
      .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    byId('fee-note').hidden = !bank.note;
    byId('fee-note').textContent = bank.note || '';
  }

  document.title = `Seller dashboard | ${CFG.storeName}`;
})();
