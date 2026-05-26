/**
 * WebEaze Promotional Banner
 * Slim fixed bar shown below the nav. Dismissed state resets each calendar day.
 * Clicking "Claim offer" opens a booking modal and dismisses the banner.
 *
 * Promo windows (recur every year):
 *   May 15 to Memorial Day  -- Setup fee waived
 *   June 15 to July 4       -- First month free (Independence Day)
 *   2 weeks before Labor Day -- Setup fee waived
 *   Thanksgiving to Nov 30  -- Setup fee waived
 *   Dec 10 to Dec 25        -- Setup fee waived (Christmas)
 *
 * Preview any banner: ?promo-preview=memorial|july4|laborday|thanksgiving|christmas
 */
(function () {
  'use strict';

  var BAR_H = 40; // px

  // ── Date helpers ─────────────────────────────────────────────────────────────

  function getMemorialDay(y) {
    var d = new Date(y, 4, 31);
    d.setDate(31 - (d.getDay() === 0 ? 6 : d.getDay() - 1));
    return d;
  }

  function getLaborDay(y) {
    var d = new Date(y, 8, 1);
    var dow = d.getDay();
    d.setDate(1 + (dow === 1 ? 0 : (8 - dow) % 7));
    return d;
  }

  function getThanksgiving(y) {
    var d = new Date(y, 10, 1);
    var dow = d.getDay();
    var firstThu = 1 + (dow <= 4 ? 4 - dow : 11 - dow);
    d.setDate(firstThu + 21);
    return d;
  }

  function midnight(d) {
    var c = new Date(d);
    c.setHours(23, 59, 59, 999);
    return c;
  }

  // ── Promo definitions ────────────────────────────────────────────────────────

  var y            = new Date().getFullYear();
  var memorialDay  = getMemorialDay(y);
  var laborDay     = getLaborDay(y);
  var thanksgiving = getThanksgiving(y);

  var PROMOS = [
    {
      id:     'memorial',
      start:  new Date(y, 4, 15),
      end:    midnight(new Date(memorialDay)),
      icon:   'fas fa-flag-usa',
      badge:  'Memorial Day Sale',
      color:  '#b91c1c',
      border: '#fca5a5',
      headline: 'Setup fee waived through Memorial Day.'
    },
    {
      id:     'july4',
      start:  new Date(y, 5, 15),
      end:    midnight(new Date(y, 6, 4)),
      icon:   'fas fa-fire-flame-curved',
      badge:  'Independence Day Special',
      color:  '#1d4ed8',
      border: '#93c5fd',
      headline: 'First month free through July 4th.'
    },
    {
      id:     'laborday',
      start:  (function () {
        var d = new Date(laborDay.getTime() - 14 * 86400000);
        d.setHours(0, 0, 0, 0);
        return d;
      })(),
      end:    midnight(new Date(laborDay)),
      icon:   'fas fa-hard-hat',
      badge:  'Labor Day Sale',
      color:  '#7851a9',
      border: '#c4b5fd',
      headline: 'Setup fee waived through Labor Day.'
    },
    {
      id:     'thanksgiving',
      start:  (function () {
        var d = new Date(thanksgiving);
        d.setHours(0, 0, 0, 0);
        return d;
      })(),
      end:    midnight(new Date(y, 10, 30)),
      icon:   'fas fa-drumstick-bite',
      badge:  'Thanksgiving Sale',
      color:  '#b45309',
      border: '#fcd34d',
      headline: 'Thankful for your business. Setup fee waived through November 30.'
    },
    {
      id:     'christmas',
      start:  new Date(y, 11, 10),
      end:    midnight(new Date(y, 11, 25)),
      icon:   'fas fa-tree',
      badge:  'Christmas Sale',
      color:  '#15803d',
      border: '#86efac',
      headline: 'Setup fee waived through Christmas Day.'
    }
  ];

  // ── Find active promo (or preview via ?promo-preview=id) ─────────────────────

  var now       = Date.now();
  var previewId = new URLSearchParams(window.location.search).get('promo-preview');
  var promo     = null;
  var i;

  if (previewId) {
    for (i = 0; i < PROMOS.length; i++) {
      if (PROMOS[i].id === previewId) { promo = PROMOS[i]; break; }
    }
    if (promo) {
      promo = Object.assign({}, promo);
      promo.end = new Date(now + 5 * 86400000);
    }
  } else {
    for (i = 0; i < PROMOS.length; i++) {
      if (now >= PROMOS[i].start.getTime() && now <= PROMOS[i].end.getTime()) {
        promo = PROMOS[i];
        break;
      }
    }
  }
  // Expose active promo globally so pricing.html can reflect it
  window.WB_ACTIVE_PROMO = promo;
  if (!promo) return;

  var isPreview = !!previewId;

  // ── Dismissal: resets each calendar day ──────────────────────────────────────

  var today = new Date().toISOString().slice(0, 10);
  var lsKey = 'wb-promo-dismissed-' + promo.id + '-' + today;
  if (!isPreview) { try { if (localStorage.getItem(lsKey)) return; } catch (e) {} }

  // ── Dismiss helper (slides bar out and records in localStorage) ───────────────

  function dismissBar() {
    bar.style.transform = 'translateY(-' + bar.offsetHeight + 'px)';
    bar.style.opacity = '0';
    spacer.style.height = '0';
    if (!isPreview) { try { localStorage.setItem(lsKey, '1'); } catch (e) {} }
    setTimeout(function () {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
      if (spacer.parentNode) spacer.parentNode.removeChild(spacer);
    }, 380);
  }

  // ── Build banner ─────────────────────────────────────────────────────────────

  var bar = document.createElement('div');
  bar.id = 'wb-promo-bar';
  bar.setAttribute('role', 'banner');
  bar.innerHTML =
    '<div class="wbpromo-inner">' +
      '<span class="wbpromo-badge"><i class="' + promo.icon + '"></i><span class="wbpromo-badge-text"> ' + promo.badge + '</span></span>' +
      '<span class="wbpromo-headline">' + promo.headline + '</span>' +
      '<button class="wbpromo-cta" id="wbpromo-cta-btn" type="button">Claim offer <i class="fas fa-arrow-right wbpromo-arrow"></i></button>' +
      '<button class="wbpromo-close" id="wbpromo-close-btn" aria-label="Dismiss" type="button"><i class="fas fa-xmark"></i></button>' +
    '</div>';

  var spacer = document.createElement('div');
  spacer.id = 'wb-promo-spacer';

  // ── Build modal ───────────────────────────────────────────────────────────────

  var modal = document.createElement('div');
  modal.id = 'wb-promo-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Book a Free Discovery Call');
  modal.innerHTML =
    '<div class="wbpm-backdrop"></div>' +
    '<div class="wbpm-panel">' +
      '<button class="wbpm-x" id="wbpm-x-btn" aria-label="Close" type="button"><i class="fas fa-xmark"></i></button>' +
      '<div class="wbpm-head">' +
        '<span class="wbpm-badge-pill" style="background:' + promo.color + '"><i class="' + promo.icon + '"></i> ' + promo.badge + '</span>' +
        '<h2 class="wbpm-title">Book a Free Discovery Call</h2>' +
        '<p class="wbpm-sub">' + promo.headline + ' Book a time below to lock it in.</p>' +
      '</div>' +
      '<div class="wbpm-embed">' +
        '<div class="meetings-iframe-container" data-src="https://meetings-na2.hubspot.com/webeaze/free-consultation?embed=true" style="min-height:690px;"></div>' +
      '</div>' +
    '</div>';

  // ── Styles (banner + modal) ───────────────────────────────────────────────────

  var s = document.createElement('style');
  s.textContent = [
    // Banner
    '#wb-promo-bar{',
      'position:fixed;left:0;right:0;z-index:9990;',
      'height:' + BAR_H + 'px;',
      'background:#fff;border-bottom:2px solid ' + promo.border + ';',
      'box-shadow:0 1px 6px rgba(0,0,0,.07);',
      'transition:transform .35s ease,opacity .3s ease;overflow:hidden;',
    '}',
    '#wb-promo-spacer{height:' + BAR_H + 'px;flex-shrink:0;transition:height .35s ease;}',
    '.wbpromo-inner{',
      'max-width:1100px;margin:0 auto;padding:0 16px;',
      'height:' + BAR_H + 'px;display:flex;align-items:center;gap:10px;',
      'font-family:"Poppins",system-ui,sans-serif;white-space:nowrap;overflow:hidden;flex-wrap:nowrap;',
    '}',
    '.wbpromo-badge{',
      'display:inline-flex;align-items:center;gap:5px;',
      'background:' + promo.color + ';color:#fff;',
      'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;',
      'padding:3px 10px;border-radius:999px;flex-shrink:0;',
    '}',
    '.wbpromo-headline{font-size:13.5px;font-weight:600;color:#111827;flex:1;overflow:hidden;text-overflow:ellipsis;}',
    '.wbpromo-cta{',
      'display:inline-flex;align-items:center;gap:6px;cursor:pointer;border:none;',
      'background:' + promo.color + ';color:#fff;',
      'font-size:12.5px;font-weight:700;font-family:"Poppins",system-ui,sans-serif;',
      'padding:5px 13px;border-radius:8px;flex-shrink:0;transition:opacity .15s;',
    '}',
    '.wbpromo-cta:hover{opacity:.85;}',
    '.wbpromo-arrow{font-size:10px;}',
    '.wbpromo-close{',
      'background:none;border:none;cursor:pointer;flex-shrink:0;',
      'color:#9ca3af;font-size:13px;padding:5px 6px;border-radius:6px;line-height:1;',
      'transition:color .14s,background .14s;',
    '}',
    '.wbpromo-close:hover{color:#374151;background:rgba(0,0,0,.06);}',
    '@media(max-width:640px){',
      '#wb-promo-bar{height:auto;overflow:visible;}',
      '.wbpromo-inner{white-space:normal;flex-wrap:wrap;height:auto;padding:7px 14px;align-items:center;gap:5px 8px;}',
      '.wbpromo-badge{order:1;flex-shrink:0;}',
      '.wbpromo-badge-text{display:none;}',
      '.wbpromo-close{order:2;margin-left:auto;}',
      '.wbpromo-headline{order:3;flex-basis:100%;font-size:12.5px;font-weight:600;white-space:normal;overflow:visible;text-overflow:clip;line-height:1.4;}',
      '.wbpromo-cta{order:4;font-size:12px;padding:4px 10px;}',
    '}',
    // Modal
    '#wb-promo-modal{',
      'display:none;position:fixed;inset:0;z-index:99999;',
      'font-family:"Poppins",system-ui,sans-serif;',
    '}',
    '#wb-promo-modal.wbpm-open{display:flex;align-items:center;justify-content:center;}',
    '.wbpm-backdrop{',
      'position:absolute;inset:0;',
      'background:rgba(0,0,0,.55);',
      'backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);',
      'animation:wbpm-fade-in .22s ease;',
    '}',
    '.wbpm-panel{',
      'position:relative;z-index:1;',
      'background:#fff;border-radius:16px;',
      'width:min(700px,96vw);',
      'max-height:90vh;overflow-y:auto;',
      '-webkit-overflow-scrolling:touch;',
      'box-shadow:0 24px 60px rgba(0,0,0,.28);',
      'animation:wbpm-slide-up .26s ease;',
    '}',
    '.wbpm-x{',
      'position:absolute;top:14px;right:14px;z-index:2;',
      'background:rgba(0,0,0,.06);border:none;cursor:pointer;',
      'width:32px;height:32px;border-radius:50%;',
      'display:flex;align-items:center;justify-content:center;',
      'color:#374151;font-size:14px;transition:background .14s;',
    '}',
    '.wbpm-x:hover{background:rgba(0,0,0,.13);}',
    '.wbpm-head{',
      'padding:28px 28px 0;',
      'display:flex;flex-direction:column;gap:8px;',
    '}',
    '.wbpm-badge-pill{',
      'display:inline-flex;align-items:center;gap:7px;',
      'color:#fff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;',
      'padding:4px 12px;border-radius:999px;width:fit-content;',
    '}',
    '.wbpm-title{font-size:clamp(1.25rem,4vw,1.6rem);font-weight:800;color:#111827;line-height:1.2;margin:0;}',
    '.wbpm-sub{font-size:13.5px;color:#6b7280;margin:0;line-height:1.5;}',
    '.wbpm-embed{padding:16px 0 0;}',
    '@media(max-width:600px){',
      '.wbpm-panel{border-radius:16px 16px 0 0;position:fixed;bottom:0;left:0;right:0;width:100%;max-height:92vh;}',
      '#wb-promo-modal.wbpm-open{align-items:flex-end;}',
      '.wbpm-head{padding:20px 18px 0;}',
    '}',
    '@keyframes wbpm-fade-in{from{opacity:0}to{opacity:1}}',
    '@keyframes wbpm-slide-up{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}'
  ].join('');
  document.head.appendChild(s);

  // ── Modal open / close ────────────────────────────────────────────────────────

  function openModal() {
    document.body.appendChild(modal);
    modal.classList.add('wbpm-open');
    document.body.style.overflow = 'hidden';

    // Load HubSpot meetings embed script if not already present on this page
    if (!document.querySelector('script[src*="MeetingsEmbedCode"]')) {
      var hs = document.createElement('script');
      hs.src = 'https://static.hsappstatic.net/MeetingsEmbed/ex/MeetingsEmbedCode.js';
      document.body.appendChild(hs);
    }

    var xBtn = document.getElementById('wbpm-x-btn');
    if (xBtn) {
      xBtn.addEventListener('click', closeModal, { once: true });
      xBtn.focus();
    }
  }

  function closeModal() {
    modal.classList.remove('wbpm-open');
    document.body.style.overflow = '';
    if (modal.parentNode) modal.parentNode.removeChild(modal);
  }

  modal.addEventListener('click', function (e) {
    if (e.target.closest('.wbpm-backdrop')) closeModal();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal.classList.contains('wbpm-open')) closeModal();
  });

  // ── Insert banner and spacer ──────────────────────────────────────────────────

  function insert() {
    var nav = document.querySelector('.nav-wrap');
    var navH = nav ? (nav.offsetHeight || 64) : 64;

    bar.style.top = navH + 'px';

    if (nav && nav.parentNode) {
      nav.parentNode.insertBefore(spacer, nav.nextSibling);
    } else {
      document.body.insertBefore(spacer, document.body.firstChild);
    }

    document.body.appendChild(bar);

    function syncSpacerHeight() {
      spacer.style.height = bar.offsetHeight + 'px';
    }
    requestAnimationFrame(syncSpacerHeight);

    window.addEventListener('load', function () {
      var n = document.querySelector('.nav-wrap');
      if (n && bar.parentNode) {
        bar.style.top = n.offsetHeight + 'px';
        requestAnimationFrame(syncSpacerHeight);
      }
    }, { once: true });

    window.addEventListener('resize', function () {
      var n = document.querySelector('.nav-wrap');
      if (n) bar.style.top = n.offsetHeight + 'px';
      requestAnimationFrame(syncSpacerHeight);
    }, { passive: true });

    // Dismiss (X button)
    var closeBtn = document.getElementById('wbpromo-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        dismissBar();
      });
    }

    // Claim offer -- dismiss bar and open modal
    var ctaBtn = document.getElementById('wbpromo-cta-btn');
    if (ctaBtn) {
      ctaBtn.addEventListener('click', function () {
        dismissBar();
        openModal();
      });
    }

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insert);
  } else {
    insert();
  }

  // ── Auto-remove when promo window ends ────────────────────────────────────────

  setInterval(function () {
    if (Date.now() > promo.end.getTime()) {
      bar.style.transform = 'translateY(-' + bar.offsetHeight + 'px)';
      bar.style.opacity = '0';
      spacer.style.height = '0';
      setTimeout(function () {
        if (bar.parentNode) bar.parentNode.removeChild(bar);
        if (spacer.parentNode) spacer.parentNode.removeChild(spacer);
      }, 380);
    }
  }, 60000);

})();
