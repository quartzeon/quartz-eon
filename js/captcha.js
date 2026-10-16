/* Cloudflare Turnstile bot check for the log in and sign up forms.
   Does nothing while QE_CONFIG.turnstileSiteKey is empty, so the forms work as before. */
window.QE_CAPTCHA = (function () {
  'use strict';

  const siteKey = ((window.QE_CONFIG || {}).turnstileSiteKey || '').trim();
  let loading = null;

  function load() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.onload = () => resolve(window.turnstile);
        script.onerror = () => {
          loading = null;
          script.remove();
          reject(new Error('The bot check could not load. Check your connection and try again.'));
        };
        document.head.appendChild(script);
      });
    }
    return loading;
  }

  const off = { token: () => Promise.resolve(undefined), reset() {}, remove() {} };

  /* Puts the check in the form, just above its submit button. Calling it again for the same form
     returns the same handle. handle.token() waits for the check and gives the one-time token,
     handle.reset() gets a fresh one after each attempt (a token works only once). */
  function attach(form) {
    if (!siteKey || !form) return off;
    if (form.qeCaptcha) return form.qeCaptcha;

    const box = document.createElement('div');
    box.className = 'captcha';
    const submit = form.querySelector('button[type="submit"]');
    form.insertBefore(box, submit || null);

    /* The button stays locked until the check says Success. This is a class, not the disabled
       attribute, because the pages turn disabled on and off themselves while they log in. */
    function lock(on) {
      if (!submit) return;
      submit.classList.toggle('is-locked', on);
      submit.setAttribute('aria-disabled', on ? 'true' : 'false');
      submit.title = on ? 'Finish the "Verify you are human" check first' : '';
    }
    function blockSubmit(event) {
      if (submit && submit.classList.contains('is-locked')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }
    form.addEventListener('submit', blockSubmit, true);
    lock(true);

    let widgetId = null;
    let failed = null;
    const rendered = load().then((turnstile) => {
      widgetId = turnstile.render(box, {
        sitekey: siteKey,
        theme: 'auto',
        size: 'flexible',
        'refresh-expired': 'auto',
        callback: () => lock(false),
        'expired-callback': () => lock(true),
        'error-callback': () => lock(true)
      });
      return turnstile;
    }).catch((err) => {
      /* Let the button work so the click shows the error and tries to load the check again. */
      failed = err;
      lock(false);
      return null;
    });

    const handle = {
      async token() {
        const turnstile = await rendered;
        if (!turnstile) {
          /* Drop this handle so the next attach() tries to load the check again. */
          handle.remove();
          throw failed || new Error('The bot check could not load. Please try again.');
        }
        /* Usually ready in a second or two. Wait up to 20 seconds before asking the person to tick it. */
        for (let i = 0; i < 80; i += 1) {
          const value = turnstile.getResponse(widgetId);
          if (value) return value;
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
        throw new Error('Please finish the "Verify you are human" check above the button, then try again.');
      },
      reset() {
        if (window.turnstile && widgetId !== null && box.isConnected) {
          lock(true);
          try { window.turnstile.reset(widgetId); } catch (err) { /* the widget is already gone */ }
        }
      },
      remove() {
        if (window.turnstile && widgetId !== null) {
          try { window.turnstile.remove(widgetId); } catch (err) { /* the widget is already gone */ }
        }
        form.removeEventListener('submit', blockSubmit, true);
        lock(false);
        box.remove();
        delete form.qeCaptcha;
      }
    };
    form.qeCaptcha = handle;
    return handle;
  }

  return { enabled: Boolean(siteKey), attach };
})();
