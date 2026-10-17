/* Quartz Eon money, shared by every page: exchange rates, the country the visitor picked and the currency picker.
   Stores price in rupees (LKR) or US dollars (USD). Every amount is shown in the currency of the chosen country
   (kept in this browser, the same on the shop, seller, products and admin pages), but payments always stay in
   the original currency, so pages that ask someone to pay show that exact amount too.
   Load it after config.js and before the page's own script. */
(function () {
  'use strict';

  const CFG = window.QE_CONFIG || {};
  const SYMBOL = CFG.currencySymbol || 'Rs.';
  const RATE_KEY = 'quartz-eon.usd-rates';
  const COUNTRY_KEY = 'quartz-eon.country';
  const RATE_MAX_AGE = 12 * 60 * 60 * 1000;
  const RATE_SOURCES = [
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    'https://latest.currency-api.pages.dev/v1/currencies/usd.json'
  ];

  const storage = {
    get(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  };
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* Countries the visitor can pick: [code, name, currency, device time zones]. On a first visit the device
     time zone picks the country (Sri Lanka if unknown). */
  const COUNTRIES = [
    ['LK', 'Sri Lanka', 'LKR', 'Asia/Colombo'],
    ['AU', 'Australia', 'AUD', 'Australia/Sydney Australia/Melbourne Australia/Brisbane Australia/Perth Australia/Adelaide Australia/Hobart Australia/Darwin'],
    ['AT', 'Austria', 'EUR', 'Europe/Vienna'],
    ['BH', 'Bahrain', 'BHD', 'Asia/Bahrain'],
    ['BD', 'Bangladesh', 'BDT', 'Asia/Dhaka'],
    ['BE', 'Belgium', 'EUR', 'Europe/Brussels'],
    ['CA', 'Canada', 'CAD', 'America/Toronto America/Vancouver America/Edmonton America/Winnipeg America/Halifax America/Regina America/St_Johns'],
    ['CN', 'China', 'CNY', 'Asia/Shanghai Asia/Urumqi'],
    ['CY', 'Cyprus', 'EUR', 'Asia/Nicosia Europe/Nicosia'],
    ['DK', 'Denmark', 'DKK', 'Europe/Copenhagen'],
    ['FI', 'Finland', 'EUR', 'Europe/Helsinki'],
    ['FR', 'France', 'EUR', 'Europe/Paris'],
    ['DE', 'Germany', 'EUR', 'Europe/Berlin'],
    ['GR', 'Greece', 'EUR', 'Europe/Athens'],
    ['HK', 'Hong Kong', 'HKD', 'Asia/Hong_Kong'],
    ['IN', 'India', 'INR', 'Asia/Kolkata Asia/Calcutta'],
    ['ID', 'Indonesia', 'IDR', 'Asia/Jakarta Asia/Makassar Asia/Jayapura'],
    ['IE', 'Ireland', 'EUR', 'Europe/Dublin'],
    ['IL', 'Israel', 'ILS', 'Asia/Jerusalem Asia/Tel_Aviv'],
    ['IT', 'Italy', 'EUR', 'Europe/Rome'],
    ['JP', 'Japan', 'JPY', 'Asia/Tokyo'],
    ['JO', 'Jordan', 'JOD', 'Asia/Amman'],
    ['KW', 'Kuwait', 'KWD', 'Asia/Kuwait'],
    ['LB', 'Lebanon', 'LBP', 'Asia/Beirut'],
    ['MY', 'Malaysia', 'MYR', 'Asia/Kuala_Lumpur Asia/Kuching'],
    ['MV', 'Maldives', 'MVR', 'Indian/Maldives'],
    ['NP', 'Nepal', 'NPR', 'Asia/Kathmandu Asia/Katmandu'],
    ['NL', 'Netherlands', 'EUR', 'Europe/Amsterdam'],
    ['NZ', 'New Zealand', 'NZD', 'Pacific/Auckland'],
    ['NO', 'Norway', 'NOK', 'Europe/Oslo'],
    ['OM', 'Oman', 'OMR', 'Asia/Muscat'],
    ['PK', 'Pakistan', 'PKR', 'Asia/Karachi'],
    ['PH', 'Philippines', 'PHP', 'Asia/Manila'],
    ['PL', 'Poland', 'PLN', 'Europe/Warsaw'],
    ['PT', 'Portugal', 'EUR', 'Europe/Lisbon'],
    ['QA', 'Qatar', 'QAR', 'Asia/Qatar'],
    ['RO', 'Romania', 'RON', 'Europe/Bucharest'],
    ['RU', 'Russia', 'RUB', 'Europe/Moscow'],
    ['SA', 'Saudi Arabia', 'SAR', 'Asia/Riyadh'],
    ['SG', 'Singapore', 'SGD', 'Asia/Singapore'],
    ['KR', 'South Korea', 'KRW', 'Asia/Seoul'],
    ['ES', 'Spain', 'EUR', 'Europe/Madrid'],
    ['SE', 'Sweden', 'SEK', 'Europe/Stockholm'],
    ['CH', 'Switzerland', 'CHF', 'Europe/Zurich'],
    ['TH', 'Thailand', 'THB', 'Asia/Bangkok'],
    ['AE', 'United Arab Emirates', 'AED', 'Asia/Dubai'],
    ['GB', 'United Kingdom', 'GBP', 'Europe/London'],
    ['US', 'United States', 'USD', 'America/New_York America/Chicago America/Denver America/Los_Angeles America/Phoenix America/Anchorage America/Detroit Pacific/Honolulu'],
    ['VN', 'Vietnam', 'VND', 'Asia/Ho_Chi_Minh Asia/Saigon']
  ];
  const countryOf = (code) => COUNTRIES.find((c) => c[0] === code) || COUNTRIES[0];
  const knownCountry = (code) => COUNTRIES.some((c) => c[0] === code);

  function startCountry() {
    const saved = storage.get(COUNTRY_KEY);
    if (knownCountry(saved)) return saved;
    const old = storage.get('quartz-eon.currency'); /* the earlier rupees / dollars switch */
    if (old === 'USD') return 'US';
    if (old === 'LKR') return 'LK';
    let zone = '';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* no time zone */ }
    const hit = COUNTRIES.find((c) => c[3].split(' ').includes(zone));
    return hit ? hit[0] : 'LK';
  }
  let country = startCountry();

  /* value: rupees per US dollar. rates: units of each currency per US dollar (lower case codes, as the source gives them).
     status: 'loading' until the first answer, then 'live' (real rates) or 'fallback' (config value, rupees and dollars only) */
  const rate = { value: CFG.fallbackUsdRate || 330, rates: {}, date: '', status: 'loading' };
  const goodLkr = (value) => value > 50 && value < 2000;

  /* Pages repaint their amounts when the country or the rates change. */
  const listeners = [];
  function changed() {
    listeners.forEach((fn) => {
      try { fn(); } catch (e) { console.error(e); }
    });
  }

  /* ---------- Turning amounts into text ---------- */
  const money2 = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rupeeNumber = (n) => Math.round(n).toLocaleString('en-US');
  const wanted = () => countryOf(country)[2];
  /* Units of a currency per US dollar, or undefined while that rate is not loaded. */
  const perUsd = (cur) => (cur === 'USD' ? 1 : cur === 'LKR' ? rate.value : rate.rates[String(cur).toLowerCase()]);
  /* The currency an amount is shown in: the chosen one, or the amount's own until the live rates have loaded. */
  const shownCur = (from) => (perUsd(wanted()) ? wanted() : from);
  const convert = (n, from, to) => (from === to ? n : (n / perUsd(from)) * perUsd(to));
  const norm = (cur) => (cur === 'USD' ? 'USD' : 'LKR');

  function currencyName(cur) {
    try { return new Intl.DisplayNames(['en'], { type: 'currency' }).of(cur); } catch (e) { return cur; }
  }

  /* An amount split into its sign and number, e.g. { sign: '€', number: '12.40' }. Rupees keep "Rs." and whole numbers.
     An exact amount (what is really paid) and big converted amounts are whole numbers; small converted amounts keep cents. */
  function moneyParts(n, cur, exact) {
    if (cur === 'LKR') return { sign: SYMBOL, number: rupeeNumber(n) };
    const whole = exact || n >= 1000 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {};
    try {
      const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, ...whole }).formatToParts(n);
      return {
        sign: parts.filter((x) => x.type === 'currency').map((x) => x.value).join(''),
        number: parts.filter((x) => x.type !== 'currency' && x.type !== 'literal').map((x) => x.value).join('')
      };
    } catch (e) {
      return { sign: cur, number: money2(n) };
    }
  }
  /* "€12.40", but "AED 45" and "Rs. 1,200" with a space after a lettered sign. */
  function moneyText(n, cur, exact) {
    const m = moneyParts(n, cur, exact);
    return /[A-Za-z.]$/.test(m.sign) ? `${m.sign} ${m.number}` : `${m.sign}${m.number}`;
  }

  /* The exact amount in its own currency (rupees or dollars), e.g. "Rs. 500" or "$5". */
  const own = (n, from) => moneyText(Number(n) || 0, norm(from), true);
  /* The amount in the chosen currency, e.g. "$1.52" (or exact when that is its own currency). */
  function shown(n, from) {
    const src = norm(from);
    const cur = shownCur(src);
    return moneyText(convert(Number(n) || 0, src, cur), cur, cur === src);
  }
  const isConverted = (from) => shownCur(norm(from)) !== norm(from);
  /* For lists and prices: "$1.52 (Rs. 500)", or just "Rs. 500" when nothing is converted. */
  const dual = (n, from) => (isConverted(from) ? `${shown(n, from)} (${own(n, from)})` : own(n, from));
  /* For "send this much": the exact amount first, "Rs. 500 (about $1.52)". */
  const pay = (n, from) => (isConverted(from) ? `${own(n, from)} (about ${shown(n, from)})` : own(n, from));
  /* Rupees for sorting by price across currencies. */
  const toLkr = (n, from) => (norm(from) === 'USD' ? n * rate.value : n);

  /* ---------- Exchange rates (cached in this browser for 12 hours) ---------- */
  function readCachedRate() {
    try {
      const cached = JSON.parse(storage.get(RATE_KEY));
      if (cached && goodLkr(cached.value) && cached.rates) return cached;
    } catch (e) { /* no usable cache */ }
    return null;
  }

  function applyRate(value, rates, date, status) {
    rate.value = value;
    rate.rates = rates;
    rate.date = date;
    rate.status = status;
  }

  async function fetchRate() {
    for (const url of RATE_SOURCES) {
      try {
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) continue;
        const data = await response.json();
        const all = (data && data.usd) || {};
        const value = Number(all.lkr);
        if (!goodLkr(value)) continue;
        /* Keep only the currencies of the country list. */
        const rates = {};
        COUNTRIES.forEach((c) => {
          const v = Number(all[c[2].toLowerCase()]);
          if (v > 0) rates[c[2].toLowerCase()] = v;
        });
        return { value, rates, date: data.date || '', fetchedAt: Date.now() };
      } catch (e) { /* try the next source */ }
    }
    return null;
  }

  /* A cached rate is used at once (so the first paint is already right), and refreshed when it is old. */
  const cached = readCachedRate();
  if (cached) applyRate(cached.value, cached.rates, cached.date, 'live');
  (async () => {
    if (cached && Date.now() - cached.fetchedAt < RATE_MAX_AGE) return;
    const fresh = await fetchRate();
    if (fresh) {
      storage.set(RATE_KEY, JSON.stringify(fresh));
      applyRate(fresh.value, fresh.rates, fresh.date, 'live');
    } else if (!cached) {
      applyRate(CFG.fallbackUsdRate || 330, {}, '', 'fallback');
    }
    changed();
  })();

  /* ---------- The country picker in the header ----------
     The pill shows only the currency code; it opens a panel with a search box, the two main currencies
     (LKR and USD) and every country. mountPicker() fills an empty <div class="cur" id="cur-widget">. */
  const CUR_MAIN = [['LK', 'Sri Lankan rupee'], ['US', 'US dollar']];
  const pickers = [];
  const svg = (path, cls) => `<svg class="i${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>`;
  const CHEV = '<path d="M6 9l6 6 6-6"/>';
  const SEARCH = '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>';
  const TICK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';

  function paintPickers() {
    pickers.forEach((paint) => paint());
  }

  function setCountry(code) {
    if (!knownCountry(code) || code === country) return;
    country = code;
    storage.set(COUNTRY_KEY, country);
    paintPickers();
    changed();
  }

  function mountPicker(box, note) {
    if (!box) return;
    box.innerHTML = `
      <button class="cur__btn" type="button" aria-expanded="false" aria-controls="cur-menu">
        <span class="cur__face"></span>${svg(CHEV, 'cur__chev')}
      </button>
      <div class="cur__menu" id="cur-menu" hidden>
        <label class="cur__search">
          ${svg(SEARCH)}
          <input type="search" placeholder="Search a country or currency" autocomplete="off" aria-label="Search a country or currency">
        </label>
        <div class="cur__scroll">
          <div class="cur__group" data-cur-main>
            <span class="cur__title">Main currencies</span>
            <div class="cur__mains">${CUR_MAIN.map(([code, label]) => {
              const c = countryOf(code);
              return `<button class="cur__main" type="button" data-country="${c[0]}"><strong>${esc(c[2])}</strong><span>${esc(label)}</span></button>`;
            }).join('')}</div>
          </div>
          <div class="cur__group">
            <span class="cur__title" data-cur-title>All countries</span>
            <div data-cur-list>${COUNTRIES.map((c) => `<button class="cur__opt" type="button" data-country="${c[0]}" data-find="${esc(`${c[1]} ${c[2]} ${c[0]}`.toLowerCase())}">`
              + `${svg(TICK, 'cur__tick')}<span class="cur__name">${esc(c[1])}</span><span class="cur__code">${esc(c[2])}</span></button>`).join('')}</div>
            <p class="cur__empty" hidden>No country found.</p>
          </div>
        </div>
        <p class="cur__note">${esc(note || "Prices are shown in this currency. You pay in the store's own currency.")}</p>
      </div>`;
    const toggle = box.querySelector('.cur__btn');
    const menu = box.querySelector('.cur__menu');
    const search = box.querySelector('.cur__search input');
    const list = box.querySelector('[data-cur-list]');

    function paint() {
      const cur = wanted();
      box.querySelector('.cur__face').textContent = cur;
      toggle.setAttribute('aria-label', `Currency: ${cur}. Change your country`);
      menu.querySelectorAll('[data-country]').forEach((el) => {
        el.setAttribute('aria-current', String(el.dataset.country === country));
      });
    }
    function filter() {
      const q = search.value.trim().toLowerCase();
      let count = 0;
      list.querySelectorAll('.cur__opt').forEach((el) => {
        el.hidden = Boolean(q) && !el.dataset.find.includes(q);
        if (!el.hidden) count += 1;
      });
      box.querySelector('[data-cur-main]').hidden = Boolean(q);
      box.querySelector('[data-cur-title]').textContent = q ? 'Results' : 'All countries';
      box.querySelector('.cur__empty').hidden = count > 0;
    }
    function setOpen(open) {
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (!open) return;
      menu.style.setProperty('--cur-top', `${Math.round(toggle.getBoundingClientRect().bottom + 10)}px`);
      search.value = '';
      filter();
      menu.querySelector('.cur__scroll').scrollTop = 0;
      search.focus();
    }
    function pick(code) {
      setOpen(false);
      toggle.focus();
      setCountry(code);
    }

    paint();
    pickers.push(paint);
    toggle.addEventListener('click', () => setOpen(menu.hidden));
    search.addEventListener('input', filter);
    menu.addEventListener('click', (event) => {
      const option = event.target.closest('[data-country]');
      if (option) pick(option.dataset.country);
    });
    /* Keys: Enter in the search box picks the first match, arrows move through the visible choices. */
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === search) {
        event.preventDefault();
        const first = list.querySelector('.cur__opt:not([hidden])');
        if (first && search.value.trim()) pick(first.dataset.country);
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const choices = [...menu.querySelectorAll('[data-country]')].filter((el) => el.offsetParent !== null);
      const at = choices.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') {
        const next = choices[at + 1];
        if (next) next.focus();
      } else if (at <= 0) {
        search.focus();
      } else {
        choices[at - 1].focus();
      }
    });
    document.addEventListener('click', (event) => {
      if (!menu.hidden && !box.contains(event.target)) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !menu.hidden) { setOpen(false); toggle.focus(); }
    });
    menu.addEventListener('focusout', (event) => {
      if (!menu.hidden && event.relatedTarget && !box.contains(event.relatedTarget)) setOpen(false);
    });
  }

  /* A country picked in another tab (for example the shop) shows here too. */
  window.addEventListener('storage', (event) => {
    if (event.key === COUNTRY_KEY && knownCountry(event.newValue) && event.newValue !== country) {
      country = event.newValue;
      paintPickers();
      changed();
    }
  });

  window.QE_MONEY = {
    COUNTRIES,
    countryOf,
    rate,
    country: () => country,
    wanted,
    perUsd,
    shownCur,
    convert,
    currencyName,
    moneyParts,
    moneyText,
    money2,
    own,
    shown,
    dual,
    pay,
    isConverted,
    toLkr,
    onChange: (fn) => listeners.push(fn),
    mountPicker
  };
})();
