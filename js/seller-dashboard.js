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
  const rs = (n) => `Rs. ${Number(n).toLocaleString('en-US')}`;
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
    if (/captcha/i.test(msg)) return 'The "Verify you are human" check failed. Please try again.';
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
    const captcha = window.QE_CAPTCHA.attach(loginForm);
    let error = null;
    try {
      const captchaToken = await captcha.token();
      ({ error } = await sb.auth.signInWithPassword({ email, password, options: { captchaToken } }));
    } catch (err) {
      error = err;
    }
    captcha.reset();
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
    if (name === 'login') window.QE_CAPTCHA.attach(loginForm);
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
    loadFee();
    loadSpotlight();
  });

  /* ---------- Status banner ---------- */
  function formatDate(value) {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* Whole days from today (this device's date) to a YYYY-MM-DD date; negative once it has passed. */
  function daysUntil(iso) {
    if (!iso) return null;
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    const now = new Date();
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  }
  const dayWord = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;
  const leftText = (n) => (n === 0 ? 'last day today' : `${dayWord(n)} left`);

  /* Where the store stands with the monthly fee: paid (Verified), free trial, or due. */
  function feeState(row) {
    const paid = daysUntil(row.paid_until);
    if (paid !== null && paid >= 0) return { kind: 'paid', days: paid, until: row.paid_until };
    const trial = daysUntil(row.free_until);
    if (trial !== null && trial >= 0) return { kind: 'trial', days: trial, until: row.free_until };
    const ended = row.paid_until || row.free_until || '';
    return { kind: 'due', days: ended ? -daysUntil(ended) : null, until: ended };
  }

  function renderStatusBanner() {
    const s = sellerRow;
    const badge = `<span class="status-badge status-badge--${s.status}">${s.status}</span>`;
    let text;
    if (s.status === 'pending') text = `Your store is waiting for approval. You can still set up your store and add products now — they will go live once approved.`;
    else if (s.status === 'suspended') text = `Your store is hidden from customers. Contact the site owner to reactivate it.`;
    else {
      const fee = feeState(s);
      if (fee.kind === 'paid') text = `Your store is live and Verified until ${formatDate(fee.until)} (${leftText(fee.days)}).`;
      else if (fee.kind === 'trial') text = `Your store is live. Free trial until ${formatDate(fee.until)} (${leftText(fee.days)}). Pay the monthly store fee to get the Verified badge.`;
      else text = 'Your store is live, but this month\'s store fee is not paid. See Store fee.';
    }
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

  /* Phone photos of a slip are often over 5 MB, so photos are made smaller (still easy to read) before upload.
     A photo is always drawn again as a new JPEG, which also drops the hidden details a phone adds to it (where and
     when it was taken, the phone model). PDFs are sent as they are. */
  function shrinkSlip(file) {
    if (!/^image\//.test(file.type)) return Promise.resolve(file);
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  const SLIP_TYPES = /^(image\/(jpeg|png|webp)|application\/pdf)$/;

  /* Slips are saved under a random name, so the file name from the phone (often a date or a name) is not kept. */
  function slipPath(kind, slip) {
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[slip.type] || 'jpg';
    const id = Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    return `${sellerRow.id}/${kind}-${id}.${ext}`;
  }

  /* The site owner's bank account is asked for only when the seller presses Pay (the store fee or an ad), and the
     server gives it only to approved stores. */
  let ownerBankRequest = null;
  function getOwnerBank() {
    if (!ownerBankRequest) {
      ownerBankRequest = sb.rpc('get_owner_bank').then(({ data, error }) => {
        if (error) throw error;
        const bank = Array.isArray(data) ? data[0] : data;
        return bank && bank.account_number ? bank : null;
      });
      ownerBankRequest.catch(() => { ownerBankRequest = null; });
    }
    return ownerBankRequest;
  }

  /* Bank details as rows split by lines; the account number has a Copy button for the bank app. */
  function bankRows(bank) {
    return [['Bank', bank.bank_name], ['Account name', bank.account_name], ['Account number', bank.account_number], ['Branch', bank.branch]]
      .filter((row) => row[1])
      .map(([k, v]) => (k === 'Account number'
        ? `<div><dt>${esc(k)}</dt><dd class="bank-num"><span>${esc(v)}</span><button class="copy-btn" type="button" data-copy="${esc(String(v).replace(/[\s-]+/g, ''))}" aria-label="Copy the account number">${icon('i-copy')}<span>Copy</span></button></dd></div>`
        : `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`))
      .join('');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(area);
      area.select();
      let done = false;
      try { done = document.execCommand('copy'); } catch (e2) { /* nothing more to try */ }
      area.remove();
      return done;
    }
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const done = await copyText(button.dataset.copy);
    toast(done ? 'Account number copied' : 'Could not copy. Hold your finger on the number to copy it.');
    const label = button.querySelector('span');
    if (done && label) {
      label.textContent = 'Copied';
      window.setTimeout(() => { label.textContent = 'Copy'; }, 1600);
    }
  });

  /* A logo is shrunk to 600 pixels (an ad poster to 1600) on a white background (JPEG has no transparency). */
  function shrinkLogo(file, maxSide = 600) {
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
    storeForm.elements.currency.value = sellerRow.currency === 'USD' ? 'USD' : 'LKR';
    storeForm.elements.about.value = sellerRow.about || '';
    byId('store-link').value = `${window.location.origin}${window.location.pathname.replace('seller.html', '')}index.html#/store/${sellerRow.store_slug}`;
    storeForm.elements.whatsapp.value = sellerRow.contact_whatsapp || '';
    storeForm.elements.telegram.value = sellerRow.contact_telegram || '';
    storeForm.elements.facebook.value = sellerRow.social_facebook || '';
    storeForm.elements.instagram.value = sellerRow.social_instagram || '';
    storeForm.elements.website.value = sellerRow.social_website || '';
    renderStoreLogo();
    fillAvailability();
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
      currency: f.currency.value === 'USD' ? 'USD' : 'LKR',
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

  /* The saved API token is never sent back to the browser: an empty box keeps the saved one. */
  let hasVpnToken = false;
  const SAVED_TOKEN_HINT = 'Saved and hidden. Leave empty to keep it.';

  async function loadVpnConfig() {
    const { data } = await sb.from('seller_vpn_config').select('panel_url, inbound_id, sub_url_base, updated_at').eq('seller_id', sellerRow.id).maybeSingle();
    hasVpnToken = !!data;
    vpnForm.elements.apiToken.placeholder = data ? SAVED_TOKEN_HINT : '';
    if (data) {
      vpnForm.elements.panelUrl.value = data.panel_url;
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
    if (!apiToken && !hasVpnToken) { showFieldError(vpnForm.elements.apiToken, 'Enter your panel’s API token.'); ok = false; }
    if (!ok) return;

    const submitButton = vpnForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    const { error } = await sb.rpc('save_my_vpn_config', {
      p_panel_url: panelUrl,
      p_api_token: apiToken,
      p_inbound_id: vpnForm.elements.inboundId.value.trim(),
      p_sub_url_base: vpnForm.elements.subUrlBase.value.trim()
    });
    submitButton.disabled = false;
    if (error) {
      byId('vpn-form-error').textContent = error.message;
      byId('vpn-form-error').hidden = false;
      return;
    }
    byId('vpn-saved-note').hidden = false;
    byId('vpn-saved-note').textContent = 'Saved just now.';
    hasVpnToken = true;
    vpnForm.elements.apiToken.value = '';
    vpnForm.elements.apiToken.placeholder = SAVED_TOKEN_HINT;
    toast('VPN panel settings saved');
  });

  /* ---------- Orders for this store: check the transfer, approve or reject ---------- */
  const SALE_STATUS = { awaiting_review: ['pending', 'Waiting for review'], paid: ['approved', 'Paid'], rejected: ['suspended', 'Not accepted'] };
  let sales = [];
  let openReports = new Map(); /* order id -> the customer's open problem report */

  function saleRow(o) {
    const [badgeClass, label] = SALE_STATUS[o.status] || ['pending', o.status];
    const amount = o.method === 'paypal' && o.amount_usd ? `$${Number(o.amount_usd).toFixed(2)} via PayPal` : `${o.currency === 'USD' ? '$' : 'Rs. '}${Number(o.amount_lkr).toLocaleString('en-US')} by bank transfer`;
    const actions = [];
    if (o.status === 'awaiting_review') {
      if (o.receipt_path) actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-slip="${esc(o.id)}"><span>View slip</span></button>`);
      actions.push(`<button class="btn btn--ink btn--sm" type="button" data-order-approve="${esc(o.id)}">${icon('i-check')}<span>Approve</span></button>`);
      actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-order-reject="${esc(o.id)}">${icon('i-pause')}<span>Reject</span></button>`);
    } else if (o.status === 'paid' && o.is_vpn && !o.delivery) {
      actions.push(`<button class="btn btn--ink btn--sm" type="button" data-order-retry="${esc(o.id)}">${icon('i-play')}<span>Retry VPN delivery</span></button>`);
    }
    const reference = o.method === 'bank' && o.reference ? ` &middot; Reference: ${esc(o.reference)}` : '';
    const report = openReports.get(o.id);
    const problem = (o.delivery_error && !o.delivery ? `<p class="prod-row__meta order-problem">VPN delivery failed: ${esc(o.delivery_error)}</p>` : '') +
      (report ? `<p class="prod-row__meta order-problem">Customer reported a problem: ${esc(report.message)}</p>` : '');
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
    const [{ data, error }, reports] = await Promise.all([
      sb.from('orders').select('*').eq('seller_id', sellerRow.id).order('created_at', { ascending: false }).limit(100),
      sb.from('order_reports').select('order_id, message').eq('seller_id', sellerRow.id).eq('status', 'open')
    ]);
    if (error) {
      toast(`Could not load orders: ${error.message}`);
      return;
    }
    openReports = new Map(((reports && reports.data) || []).map((r) => [r.order_id, r]));
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
    emailCustomer(id);
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
    emailCustomer(id);
    toast('Order rejected');
    loadSales();
  }

  /* Tells the customer by email that the order was approved or rejected (the server sends it once). */
  function emailCustomer(orderId) {
    sb.functions.invoke('notify', { body: { kind: 'order_decided', id: orderId } }).catch(() => {});
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
    if (approve) {
      /* A slip photo can be faked: make the seller check the bank first. */
      const o = sales.find((s) => s.id === approve.dataset.orderApprove);
      const money = o ? `${o.currency === 'USD' ? '$' : 'Rs. '}${Number(o.amount_lkr).toLocaleString('en-US')}${o.reference ? ` (reference ${o.reference})` : ''}` : 'the money';
      if (window.confirm(`Did ${money} really arrive in your bank account?\n\nCheck your bank app or statement first. A slip photo can be faked. Once approved, the product is delivered and this cannot be undone.`)) approveSale(approve.dataset.orderApprove);
      return;
    }
    const reject = t.closest('[data-order-reject]');
    if (reject) { if (window.confirm('Reject this order? The customer will see it as not accepted.')) rejectSale(reject.dataset.orderReject); return; }
    const retry = t.closest('[data-order-retry]');
    if (retry) { retrySale(retry.dataset.orderRetry); return; }
    const slip = t.closest('[data-slip]');
    if (slip) viewSlip(slip.dataset.slip);
  });

  /* ---------- Availability: Online / Away and opening hours ---------- */
  const availabilityForm = byId('availability-form');
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  /* Monday to Saturday 9 to 6 until the seller changes it. */
  const defaultHours = () => DAYS.map((d, i) => ({ open: i !== 0, from: '09:00', to: '18:00' }));
  let hours = defaultHours();

  function renderHoursRows() {
    byId('av-hours').innerHTML = hours.map((h, i) => `
      <div class="av-row" data-day="${i}">
        <span class="av-row__day">${DAYS[i]}</span>
        <label class="check-row"><input type="checkbox" data-field="open"${h.open ? ' checked' : ''}><span>Open</span></label>
        <input type="time" data-field="from" value="${esc(h.from)}"${h.open ? '' : ' disabled'} aria-label="${DAYS[i]} opens">
        <input type="time" data-field="to" value="${esc(h.to)}"${h.open ? '' : ' disabled'} aria-label="${DAYS[i]} closes">
      </div>`).join('');
  }

  function syncAvailability() {
    byId('av-hours').hidden = availabilityForm.elements.mode.value !== 'hours';
  }

  function fillAvailability() {
    const saved = Array.isArray(sellerRow.availability_hours) && sellerRow.availability_hours.length === 7 ? sellerRow.availability_hours : null;
    hours = saved ? saved.map((h) => ({ open: !!h.open, from: h.from || '09:00', to: h.to || '18:00' })) : defaultHours();
    availabilityForm.elements.mode.value = sellerRow.availability_mode || 'none';
    renderHoursRows();
    syncAvailability();
  }

  availabilityForm.querySelectorAll('input[name="mode"]').forEach((radio) => radio.addEventListener('change', syncAvailability));

  byId('av-hours').addEventListener('change', (event) => {
    const row = event.target.closest('[data-day]');
    const field = event.target.dataset.field;
    if (!row || !field) return;
    const h = hours[Number(row.dataset.day)];
    if (field === 'open') { h.open = event.target.checked; renderHoursRows(); return; }
    h[field] = event.target.value;
  });

  availabilityForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = byId('availability-error');
    errorBox.hidden = true;
    const mode = availabilityForm.elements.mode.value;
    if (mode === 'hours') {
      const bad = hours.findIndex((h) => h.open && (!h.from || !h.to || h.from >= h.to));
      if (bad >= 0) { errorBox.textContent = `${DAYS[bad]}: the closing time must be after the opening time.`; errorBox.hidden = false; return; }
      if (!hours.some((h) => h.open)) { errorBox.textContent = 'Open at least one day, or choose a different option.'; errorBox.hidden = false; return; }
    }
    const button = availabilityForm.querySelector('button[type="submit"]');
    button.disabled = true;
    const details = { availability_mode: mode, availability_hours: hours };
    const { error } = await sb.from('sellers').update(details).eq('id', sellerRow.id);
    button.disabled = false;
    if (error) { errorBox.textContent = error.message; errorBox.hidden = false; return; }
    Object.assign(sellerRow, details);
    toast('Availability saved');
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
      const tab = document.querySelector('[data-dash-tab="telegram-card"]');
      if (tab) tab.hidden = true;
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

  /* ---------- The monthly store fee and the Verified badge ---------- */
  const FEE_STATUS = { awaiting_review: ['pending', 'Waiting for review'], approved: ['approved', 'Approved'], rejected: ['suspended', 'Not accepted'] };
  let feeSettings = { monthly_fee: CFG.sellerMonthlyFee || 500, fee_required: false };
  let feeWaiting = null;
  let slipPreviewUrl = '';

  function paintFeeStatus(payments) {
    const fee = feeState(sellerRow);
    const price = rs(feeSettings.monthly_fee);
    const soon = fee.kind !== 'due' && fee.days <= 5;
    /* The site owner's bank account is only for approved stores, so a new store cannot open it yet. */
    const canPay = sellerRow.status === 'approved' || sellerRow.status === 'suspended';

    /* One line that says where the store stands, next to a round icon in the matching colour. */
    let tone, glyph, title, text;
    if (!canPay && fee.kind === 'due') {
      tone = 'warn';
      glyph = 'i-clock';
      title = 'Waiting for approval';
      text = 'The site owner checks new stores first. You can pay the fee once your store is approved.';
    } else if (fee.kind === 'paid') {
      tone = soon ? 'warn' : 'ok';
      glyph = 'i-check';
      title = `Your store is <span class="verified-pill">${verifiedIcon()} Verified</span>`;
      text = `Paid until ${formatDate(fee.until)} (${leftText(fee.days)}).`;
    } else if (fee.kind === 'trial') {
      tone = soon ? 'warn' : 'ok';
      glyph = 'i-clock';
      title = 'Free trial';
      text = `Your trial ends on ${formatDate(fee.until)} (${leftText(fee.days)}). Pay the fee to get the Verified badge.`;
    } else {
      tone = 'bad';
      glyph = 'i-card';
      title = 'Your store fee is due';
      text = feeSettings.fee_required
        ? 'Your store is hidden from the shop until you pay.'
        : 'Pay it to get the Verified badge next to your store name.';
    }
    byId('fee-hero').innerHTML = `
      <span class="fee-hero__icon fee-hero__icon--${tone}">${icon(glyph)}</span>
      <div class="fee-hero__body"><p class="fee-hero__title">${title}</p><p class="fee-hero__text">${esc(text)}</p></div>`;

    /* Three figures: is this month paid, how long is left, and until when. */
    const month = { paid: ['Paid', 'ok'], trial: ['Free trial', soon ? 'warn' : 'ok'], due: ['Not paid', 'bad'] }[fee.kind];
    const left = fee.kind === 'due'
      ? (fee.days ? `Ended ${dayWord(fee.days)} ago` : 'Ended today')
      : (fee.days === 0 ? 'Last day today' : dayWord(fee.days));
    byId('fee-summary').innerHTML = `
      <div class="fee-box fee-box--${month[1]}"><span>This month</span><strong>${month[0]}</strong></div>
      <div class="fee-box fee-box--${fee.kind === 'due' ? 'bad' : soon ? 'warn' : 'ok'}"><span>Time left</span><strong>${esc(left)}</strong></div>
      <div class="fee-box"><span>${fee.kind === 'due' ? 'Ended on' : fee.kind === 'trial' ? 'Trial ends' : 'Paid until'}</span><strong>${fee.until ? esc(formatDate(fee.until)) : '-'}</strong></div>`;
    /* A store that is not approved yet has nothing to pay, so the red "Not paid" figures stay out of the way. */
    byId('fee-summary').hidden = !canPay && fee.kind === 'due';

    /* One slip at a time: while one is waiting, it takes the place of the Pay part. */
    feeWaiting = (payments || []).find((p) => p.status === 'awaiting_review') || null;
    if (feeWaiting) closeFeeFlow();
    byId('fee-pay').hidden = !!feeWaiting;
    byId('fee-wait').hidden = !feeWaiting;
    byId('fee-wait-text').textContent = feeWaiting
      ? `You sent ${rs(feeWaiting.amount_lkr)} on ${formatDate(feeWaiting.created_at)}. 30 days are added once the site owner approves it. Sent the wrong slip? Take it back and send a new one.`
      : '';

    const payButton = byId('fee-pay-open');
    payButton.textContent = `Pay ${price}`;
    payButton.disabled = !canPay;
    byId('fee-lead').textContent = canPay
      ? `${price} a month, by bank transfer to the site owner. Each payment adds 30 days.`
      : `${price} a month. You can pay once the site owner approves your store.`;

    const flag = byId('fee-nav-flag');
    flag.hidden = !canPay || !(soon || fee.kind === 'due');
    flag.textContent = fee.kind === 'due' ? 'Due' : dayWord(fee.days);
  }

  function verifiedIcon() {
    return '<svg class="verified-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 1.8l2.4 1.7 2.9-.2 1.1 2.7 2.5 1.5-.5 2.9 1.2 2.7-1.9 2.2-.2 2.9-2.8.9-1.8 2.3-2.7-1.1-2.7 1.1-1.8-2.3-2.8-.9-.2-2.9L2.3 12.4l1.2-2.7-.5-2.9 2.5-1.5 1.1-2.7 2.9.2z" fill="currentColor" stroke="none"/><path d="M8 12.3l2.6 2.6L16 9.5" fill="none" stroke="#fff" stroke-width="2"/></svg>';
  }

  /* A past payment as one row: a coloured dot, the amount, when it was sent and checked, and its status. */
  function feeRow(p) {
    const [badgeClass, label] = FEE_STATUS[p.status] || ['pending', p.status];
    const tone = { approved: 'ok', rejected: 'bad' }[p.status] || 'warn';
    const meta = [`Sent ${formatDate(p.created_at)}`];
    if (p.status !== 'awaiting_review' && p.reviewed_at) meta.push(`checked ${formatDate(p.reviewed_at)}`);
    if (p.reference) meta.push(p.reference);
    if (p.status !== 'awaiting_review' && !p.receipt_path) meta.push('slip deleted');
    return `
      <div class="fee-row">
        <span class="fee-row__dot fee-row__dot--${tone}" aria-hidden="true"></span>
        <div class="fee-row__main">
          <p class="fee-row__amount">${esc(rs(p.amount_lkr))}</p>
          <p class="fee-row__meta">${meta.map(esc).join(' &middot; ')}</p>
        </div>
        <span class="status-badge status-badge--${badgeClass}">${esc(label)}</span>
      </div>`;
  }

  async function loadFee() {
    const [{ data: settings }, { data: payments }] = await Promise.all([
      sb.from('site_settings').select('*').maybeSingle(),
      sb.from('fee_payments').select('*').eq('seller_id', sellerRow.id).order('created_at', { ascending: false }).limit(10)
    ]);
    if (settings) feeSettings = settings;
    paintFeeStatus(payments || []);
    byId('fee-history-wrap').hidden = !(payments && payments.length);
    byId('fee-history').innerHTML = (payments || []).map(feeRow).join('');
  }

  function paintFeeBank(bank) {
    const price = rs(feeSettings.monthly_fee);
    byId('fee-send-title').textContent = bank ? `Send ${price} to this account` : `Send ${price} to the site owner`;
    byId('fee-bank').hidden = !bank;
    byId('fee-bank').innerHTML = bank ? bankRows(bank) : '';
    const note = bank ? bank.note : 'The site owner has not added bank details yet, so please message them first.';
    byId('fee-note').hidden = !note;
    byId('fee-note').textContent = note || '';
  }

  /* The bank details stay off the page until Pay is pressed, and Not now takes them off again. */
  function closeFeeFlow() {
    byId('fee-flow').hidden = true;
    byId('fee-pay-open').hidden = false;
    byId('fee-bank').innerHTML = '';
    byId('fee-form').reset();
    setSlipPick(null);
    showFieldError(byId('fee-receipt'), '');
    byId('fee-form-error').hidden = true;
    byId('fee-pay-error').hidden = true;
  }

  byId('fee-pay-open').addEventListener('click', async () => {
    const button = byId('fee-pay-open');
    const label = button.textContent;
    const errorBox = byId('fee-pay-error');
    errorBox.hidden = true;
    button.disabled = true;
    button.textContent = 'Opening...';
    try {
      paintFeeBank(await getOwnerBank());
      byId('fee-flow').hidden = false;
      button.hidden = true;
    } catch (err) {
      errorBox.textContent = (err && err.message) || 'Could not open the payment details. Please try again.';
      errorBox.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
  byId('fee-pay-close').addEventListener('click', closeFeeFlow);

  /* The chosen slip shows as a small picture (or a PDF mark) with its name, so the seller can check it first. */
  function setSlipPick(file) {
    if (slipPreviewUrl) { URL.revokeObjectURL(slipPreviewUrl); slipPreviewUrl = ''; }
    const pick = byId('fee-receipt-pick');
    pick.classList.toggle('has-file', !!file);
    byId('fee-receipt-name').textContent = file ? file.name : 'Choose the slip';
    pick.querySelector('small').textContent = file ? 'Tap to choose another' : 'JPG, PNG, WebP or PDF, up to 5 MB';
    if (file && /^image\//.test(file.type)) {
      slipPreviewUrl = URL.createObjectURL(file);
      byId('fee-receipt-art').innerHTML = `<img src="${slipPreviewUrl}" alt="">`;
    } else {
      byId('fee-receipt-art').innerHTML = file ? '<span class="slip-pick__pdf">PDF</span>' : icon('i-image');
    }
  }

  byId('fee-receipt').addEventListener('change', (event) => {
    const input = event.target;
    const file = (input.files || [])[0] || null;
    showFieldError(input, '');
    if (file && !SLIP_TYPES.test(file.type)) {
      showFieldError(input, 'Use a JPG, PNG, WebP or PDF file.');
      input.value = '';
      setSlipPick(null);
      return;
    }
    setSlipPick(file);
  });

  byId('fee-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = byId('fee-form');
    const file = form.elements.receipt.files[0];
    const errorBox = byId('fee-form-error');
    errorBox.hidden = true;
    showFieldError(form.elements.receipt, '');
    if (!file) { showFieldError(form.elements.receipt, 'Attach the payment slip (a photo or a PDF).'); return; }
    if (!SLIP_TYPES.test(file.type)) { showFieldError(form.elements.receipt, 'Use a JPG, PNG, WebP or PDF file.'); return; }
    if (file.type === 'application/pdf' && file.size > 5 * 1024 * 1024) { showFieldError(form.elements.receipt, 'That PDF is over 5 MB. Send a photo of the slip instead.'); return; }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Sending...';
    let path = null;
    try {
      const slip = await shrinkSlip(file);
      if (slip.size > 5 * 1024 * 1024) throw new Error('That photo is too large even after making it smaller. Try a smaller photo or a screenshot.');
      const target = slipPath('fee', slip);
      const { error: uploadError } = await sb.storage.from('receipts').upload(target, slip, { contentType: slip.type || file.type });
      if (uploadError) {
        if (/row-level security|policy/i.test(uploadError.message || '')) throw new Error('You have sent too many slips today. Please try again tomorrow.');
        throw uploadError;
      }
      path = target;
      const { data: paymentId, error } = await sb.rpc('submit_fee_payment', { p_reference: form.elements.reference.value.trim(), p_receipt_path: path });
      if (error) throw error;
      path = null; /* the slip now belongs to the payment */
      /* Tell the owner on Telegram, with the slip and Approve / Reject buttons. */
      sb.functions.invoke('notify', { body: { kind: 'fee_payment', id: paymentId } }).catch(() => {});
      closeFeeFlow();
      toast('Slip sent. You will be verified once the owner approves it.');
      loadFee();
    } catch (err) {
      /* A slip that did not become a payment is not kept. */
      if (path) sb.storage.from('receipts').remove([path]).catch(() => {});
      errorBox.textContent = (err && err.message) || 'Something went wrong. Please try again.';
      errorBox.hidden = false;
      if (/still waiting/i.test((err && err.message) || '')) loadFee();
    } finally {
      button.disabled = false;
      button.textContent = 'Send the slip';
    }
  });

  /* Take back a slip that is still waiting (a wrong photo, for example). The payment and the file are deleted. */
  byId('fee-wait-cancel').addEventListener('click', async () => {
    if (!feeWaiting) return;
    if (!window.confirm('Take this slip back? It is deleted, and you can send a new one.')) return;
    const button = byId('fee-wait-cancel');
    button.disabled = true;
    const { data: slip, error } = await sb.rpc('cancel_fee_payment', { p_id: feeWaiting.id });
    button.disabled = false;
    if (error) { toast(error.message || 'Could not take the slip back.'); loadFee(); return; }
    if (slip) await sb.storage.from('receipts').remove([slip]).catch(() => {});
    toast('Slip taken back and deleted');
    loadFee();
  });

  /* ---------- Ads: the seller buys time in the popup the shop shows (called "spotlight" in the code and database,
     because ad blockers block addresses and classes with "ad" in them) ---------- */
  const SPOT_STATUS = { awaiting_review: ['pending', 'Waiting for review'], approved: ['approved', 'Approved'], rejected: ['suspended', 'Not accepted'] };
  const spot = { step: 1, packs: [], pack: null, qty: 1, poster: null, posterUrl: '', bank: null, bankError: '' };

  /* 24 hours reads "1 day", 36 hours reads "36 hours". */
  function spanText(hours) {
    if (hours % 24 === 0) return dayWord(hours / 24);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }

  function formatDateTime(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  }

  /* Time left until a moment, in whole hours under two days, else in whole days. */
  function timeLeft(value) {
    const hours = Math.max(1, Math.ceil((new Date(value).getTime() - Date.now()) / 3600000));
    return hours < 48 ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : dayWord(Math.floor(hours / 24));
  }

  function spotThumb(path) {
    return `<span class="prod-row__art spot-thumb">${path ? `<img src="${esc(logoUrl(path))}" alt="" loading="lazy">` : icon('i-megaphone')}</span>`;
  }

  function myAdRow(s) {
    const now = Date.now();
    const start = new Date(s.starts_at).getTime();
    const end = new Date(s.ends_at).getTime();
    let badge, meta;
    if (!s.active) { badge = ['suspended', 'Paused']; meta = 'Paused by the site owner. Message them if this is a mistake.'; }
    else if (end <= now) { badge = ['', 'Ended']; meta = `Ended ${formatDateTime(s.ends_at)}`; }
    else if (start > now) { badge = ['pending', 'Starts later']; meta = `Starts ${formatDateTime(s.starts_at)}, ends ${formatDateTime(s.ends_at)}`; }
    else { badge = ['approved', 'Running']; meta = `Ends ${formatDateTime(s.ends_at)} (${timeLeft(s.ends_at)} left)`; }
    return `
      <article class="prod-row">
        <div class="prod-row__main">${spotThumb(s.image)}<div class="prod-row__text">
          <p class="prod-row__name">${esc(s.title || sellerRow.store_name)} <span class="status-badge${badge[0] ? ` status-badge--${badge[0]}` : ''}">${esc(badge[1])}</span></p>
          <p class="prod-row__meta">${esc(meta)}</p>
        </div></div>
      </article>`;
  }

  function requestRow(r) {
    const [badgeClass, label] = SPOT_STATUS[r.status] || ['pending', r.status];
    const time = r.qty > 1 ? `${r.qty} × ${spanText(r.hours)}` : spanText(r.hours);
    return `
      <article class="prod-row">
        <div class="prod-row__main">${spotThumb(r.image)}<div class="prod-row__text">
          <p class="prod-row__name">${esc(r.title || sellerRow.store_name)} <span class="status-badge status-badge--${badgeClass}">${esc(label)}</span></p>
          <p class="prod-row__meta">${esc(time)} &middot; ${esc(rs(r.amount_lkr))} &middot; sent ${esc(formatDate(r.created_at))}${r.reference ? ` &middot; ${esc(r.reference)}` : ''}</p>
        </div></div>
      </article>`;
  }

  async function loadSpotlight() {
    const [{ data: settings }, { data: packs }, { data: mine }, { data: requests }] = await Promise.all([
      sb.from('site_settings').select('owner_telegram').maybeSingle(),
      sb.from('spotlight_packages').select('*').order('hours').order('price'),
      sb.rpc('my_spotlights'),
      sb.from('spotlight_requests').select('*').eq('seller_id', sellerRow.id).order('created_at', { ascending: false }).limit(10)
    ]);
    const tg = settings && settings.owner_telegram;
    byId('spot-contact').hidden = !tg;
    if (tg) {
      byId('spot-contact-link').href = `https://t.me/${encodeURIComponent(tg)}`;
      byId('spot-contact-name').textContent = `Message @${tg}`;
    }
    byId('spot-mine-wrap').hidden = !(mine && mine.length);
    byId('spot-mine').innerHTML = (mine || []).map(myAdRow).join('');
    byId('spot-requests-wrap').hidden = !(requests && requests.length);
    byId('spot-requests').innerHTML = (requests || []).map(requestRow).join('');
    spot.packs = packs || [];
    renderPacks();
  }

  /* The packages the owner offers, as glass boxes. The first one is picked to start with. */
  function renderPacks() {
    const box = byId('spot-packs');
    if (spot.pack) spot.pack = spot.packs.find((p) => p.id === spot.pack.id) || null;
    if (!spot.pack) spot.pack = spot.packs[0] || null;
    if (!spot.pack) {
      box.innerHTML = '<p class="spot-packs__empty">No ad times are offered right now. Please message the site owner.</p>';
      byId('spot-qty').hidden = true;
      byId('spot-total').innerHTML = '';
      return;
    }
    box.innerHTML = spot.packs.map((p) => `
      <button type="button" class="spot-pack" role="radio" aria-checked="${p.id === spot.pack.id}" data-pack="${esc(p.id)}">
        <span class="spot-pack__check">${icon('i-check')}</span>
        <span class="spot-pack__time">${esc(spanText(p.hours))}</span>
        <span class="spot-pack__price">${esc(rs(p.price))}</span>
        <span class="spot-pack__note">${p.max_qty > 1 ? `Buy up to ${p.max_qty} at once` : 'One at a time'}</span>
      </button>`).join('');
    paintQty();
  }

  function paintQty() {
    const p = spot.pack;
    if (!p) return;
    spot.qty = Math.min(Math.max(1, spot.qty), p.max_qty);
    byId('spot-qty').hidden = p.max_qty <= 1;
    byId('spot-qty-value').textContent = String(spot.qty);
    byId('spot-qty-minus').disabled = spot.qty <= 1;
    byId('spot-qty-plus').disabled = spot.qty >= p.max_qty;
    byId('spot-qty-max').textContent = `× ${spanText(p.hours)}, up to ${p.max_qty}`;
    byId('spot-total').innerHTML = `<span>Your ad runs for <strong>${esc(spanText(p.hours * spot.qty))}</strong></span><span class="spot-total__price">${esc(rs(p.price * spot.qty))}</span>`;
  }

  byId('spot-packs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-pack]');
    if (!button) return;
    spot.pack = spot.packs.find((p) => p.id === button.dataset.pack) || spot.pack;
    byId('spot-pack-error').hidden = true;
    byId('spot-packs').querySelectorAll('[data-pack]').forEach((b) => b.setAttribute('aria-checked', String(b === button)));
    paintQty();
  });
  byId('spot-qty-minus').addEventListener('click', () => { spot.qty -= 1; paintQty(); });
  byId('spot-qty-plus').addEventListener('click', () => { spot.qty += 1; paintQty(); });

  /* The poster is made smaller in the browser and uploaded only when the request is sent. */
  function setSpotPoster(blob) {
    if (spot.posterUrl) URL.revokeObjectURL(spot.posterUrl);
    spot.poster = blob;
    spot.posterUrl = blob ? URL.createObjectURL(blob) : '';
    byId('spot-poster-img').innerHTML = blob ? `<img src="${spot.posterUrl}" alt="Your poster">` : icon('i-image');
    byId('spot-poster-btn').textContent = blob ? 'Change the picture' : 'Choose a picture';
    byId('spot-poster-clear').hidden = !blob;
  }

  byId('spot-poster-file').addEventListener('change', async (event) => {
    const input = event.target;
    const file = (input.files || [])[0];
    showFieldError(input, '');
    if (!file) return;
    try {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Use a JPG, PNG or WebP picture.');
      const blob = await shrinkLogo(file, 1600);
      if (blob.size > 3 * 1024 * 1024) throw new Error('That picture is too large. Try a smaller one.');
      setSpotPoster(blob);
    } catch (err) {
      showFieldError(input, err.message);
    }
    input.value = '';
  });
  byId('spot-poster-clear').addEventListener('click', () => setSpotPoster(null));

  function paintSpotSummary() {
    const form = byId('spot-buy-form');
    const p = spot.pack;
    const total = p.price * spot.qty;
    const rows = [
      ['Headline', form.elements.title.value.trim() || `${sellerRow.store_name} (your store name)`],
      ['Offer line', form.elements.message.value.trim() || 'The About text of your store'],
      ['Poster', spot.poster ? 'Added' : 'Your store logo'],
      ['Time', spot.qty > 1 ? `${spot.qty} × ${spanText(p.hours)} = ${spanText(p.hours * spot.qty)}` : spanText(p.hours)],
      ['To pay', rs(total)]
    ];
    byId('spot-summary').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    byId('spot-pay-lead').textContent = spot.bankError
      ? spot.bankError
      : spot.bank
        ? `Send ${rs(total)} to the site owner's account below, then attach the slip.`
        : `Send ${rs(total)} to the site owner. They have not added bank details yet, so please message them first.`;
    byId('spot-bank').hidden = !spot.bank;
    byId('spot-bank').innerHTML = spot.bank ? bankRows(spot.bank) : '';
    byId('spot-bank-note').hidden = !(spot.bank && spot.bank.note);
    byId('spot-bank-note').textContent = spot.bank && spot.bank.note ? spot.bank.note : '';
  }

  async function goSpotStep(n) {
    if (n === 3) {
      if (!spot.pack) {
        byId('spot-pack-error').textContent = 'Choose how long your ad runs.';
        byId('spot-pack-error').hidden = false;
        return;
      }
      try {
        spot.bank = await getOwnerBank();
        spot.bankError = '';
      } catch (err) {
        spot.bank = null;
        spot.bankError = (err && err.message) || 'Could not open the payment details. Please try again.';
      }
      paintSpotSummary();
    } else {
      /* The bank details are only on the page while the payment step is open. */
      byId('spot-bank').innerHTML = '';
    }
    spot.step = n;
    document.querySelectorAll('[data-spot-step]').forEach((el) => { el.hidden = Number(el.dataset.spotStep) !== n; });
    document.querySelectorAll('[data-step-dot]').forEach((li) => {
      const k = Number(li.dataset.stepDot);
      li.classList.toggle('is-done', k < n);
      if (k === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    const steps = byId('spot-steps');
    if (steps.getBoundingClientRect().top < 0) steps.scrollIntoView({ block: 'start' });
  }

  byId('spot-buy-form').addEventListener('click', (event) => {
    const go = event.target.closest('[data-spot-go]');
    if (go) goSpotStep(Number(go.dataset.spotGo));
  });

  byId('spot-buy-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    /* Enter in a field of the first two steps moves on instead of sending. */
    if (spot.step < 3) { goSpotStep(spot.step + 1); return; }
    const form = byId('spot-buy-form');
    const file = form.elements.receipt.files[0];
    const errorBox = byId('spot-form-error');
    errorBox.hidden = true;
    showFieldError(form.elements.receipt, '');
    if (!file) { showFieldError(form.elements.receipt, 'Attach the payment slip (a photo or a PDF).'); return; }
    if (!SLIP_TYPES.test(file.type)) { showFieldError(form.elements.receipt, 'Use a JPG, PNG, WebP or PDF file.'); return; }
    if (file.type === 'application/pdf' && file.size > 5 * 1024 * 1024) { showFieldError(form.elements.receipt, 'That PDF is over 5 MB. Send a photo of the slip instead.'); return; }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    let posterPath = null;
    let slipPathSent = null;
    let sent = false;
    try {
      if (spot.poster) {
        const path = `spotlight/${sellerRow.id}/${Date.now()}.jpg`;
        const { error: posterError } = await sb.storage.from(LOGO_BUCKET).upload(path, spot.poster, { contentType: 'image/jpeg' });
        if (posterError) throw new Error(`Could not upload the poster: ${posterError.message}`);
        posterPath = path;
      }
      const slip = await shrinkSlip(file);
      if (slip.size > 5 * 1024 * 1024) throw new Error('That photo is too large even after making it smaller. Try a smaller photo or a screenshot.');
      const target = slipPath('spot', slip);
      const { error: uploadError } = await sb.storage.from('receipts').upload(target, slip, { contentType: slip.type || file.type });
      if (uploadError) {
        if (/row-level security|policy/i.test(uploadError.message || '')) throw new Error('You have sent too many slips today. Please try again tomorrow.');
        throw uploadError;
      }
      slipPathSent = target;
      const { data: requestId, error } = await sb.rpc('submit_spotlight_request', {
        p_package_id: spot.pack.id,
        p_qty: spot.qty,
        p_title: form.elements.title.value.trim(),
        p_message: form.elements.message.value.trim(),
        p_image: posterPath,
        p_reference: form.elements.reference.value.trim(),
        p_receipt_path: slipPathSent
      });
      if (error) throw error;
      sent = true;
      /* Tell the owner on Telegram, with the slip and Approve / Reject buttons. */
      sb.functions.invoke('notify', { body: { kind: 'spotlight_request', id: requestId } }).catch(() => {});
      form.reset();
      setSpotPoster(null);
      spot.qty = 1;
      goSpotStep(1);
      toast('Request sent. Your ad starts once the site owner approves it.');
      loadSpotlight();
    } catch (err) {
      if (posterPath && !sent) sb.storage.from(LOGO_BUCKET).remove([posterPath]).catch(() => {});
      if (slipPathSent && !sent) sb.storage.from('receipts').remove([slipPathSent]).catch(() => {});
      errorBox.textContent = (err && err.message) || 'Something went wrong. Please try again.';
      errorBox.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
  document.title = `Seller dashboard | ${CFG.storeName}`;
})();


/* Seller dashboard side menu: shows one section at a time. The address ends in #<section id>, so links
   such as seller.html#vpn-card (from the product editor) open the right section. */
(function () {
  'use strict';
  const nav = document.getElementById('dash-nav');
  if (!nav) return;
  const links = Array.from(nav.querySelectorAll('[data-dash-tab]'));
  const ids = links.map((a) => a.dataset.dashTab);
  function show(id) {
    /* An id inside a section (such as #store-contact) opens that section and scrolls to the spot. */
    const inner = id && !ids.includes(id) ? document.getElementById(id) : null;
    const owner = inner && ids.find((tab) => { const el = document.getElementById(tab); return el && el.contains(inner); });
    if (owner) id = owner;
    if (!ids.includes(id)) id = ids[0];
    ids.forEach((other) => { const el = document.getElementById(other); if (el) el.hidden = other !== id; });
    links.forEach((a) => { if (a.dataset.dashTab === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (owner) requestAnimationFrame(() => inner.scrollIntoView({ block: 'start' }));
  }
  nav.addEventListener('click', (event) => {
    const link = event.target.closest('[data-dash-tab]');
    if (!link) return;
    event.preventDefault();
    history.replaceState(null, '', `#${link.dataset.dashTab}`);
    show(link.dataset.dashTab);
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1));
})();
