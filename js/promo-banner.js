/**
 * WebEaze Promotional Banner
 * Auto-shows holiday-themed sale banners. Dismissed state resets daily.
 *
 * Promo windows (recur every year):
 *   May 15 – Memorial Day   — Setup fee waived
 *   June 15 – July 4        — First month free (Independence Day)
 *   2 weeks – Labor Day     — Setup fee waived
 *   Thanksgiving – Nov 30   — Setup fee waived
 *   Dec 10 – Dec 25         — Setup fee waived (Christmas)
 *
 * Preview any banner: ?promo-preview=memorial|july4|laborday|thanksgiving|christmas
 */
(function () {
  'use strict';

  // ── Date helpers ─────────────────────────────────────────────────────────────

  function getMemorialDay(y) {
    // Last Monday of May
    var d = new Date(y, 4, 31);
    d.setDate(31 - (d.getDay() === 0 ? 6 : d.getDay() - 1));
    return d;
  }

  function getLaborDay(y) {
    // First Monday of September
    var d = new Date(y, 8, 1);
    var dow = d.getDay();
    d.setDate(1 + (dow === 1 ? 0 : (8 - dow) % 7));
    return d;
  }

  function getThanksgiving(y) {
    // 4th Thursday of November
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

  function timeLeftLabel(end) {
    var ms = end - Date.now();
    if (ms <= 0) return null;
    var mins  = Math.floor(ms / 60000);
    var hours = Math.floor(ms / 3600000);
    var days  = Math.floor(ms / 86400000);
    if (days >= 2)  return days  + ' days';
    if (hours >= 1) return hours + ' hour'  + (hours === 1 ? '' : 's');
    if (mins >= 1)  return mins  + ' minute' + (mins === 1 ? '' : 's');
    return 'a few moments';
  }

  // ── Promo definitions ────────────────────────────────────────────────────────

  var y            = new Date().getFullYear();
  var memorialDay  = getMemorialDay(y);
  var laborDay     = getLaborDay(y);
  var thanksgiving = getThanksgiving(y);

  var PROMOS = [
    {
      id:     'memorial',
      start:  new Date(y, 4, 15),           // May 15
      end:    midnight(new Date(memorialDay)),
      icon:   'fas fa-flag-usa',
      badge:  'Memorial Day Sale',
      color:  '#b91c1c',
      border: 'rgba(185,28,28,0.25)',
      headline: function () {
        return 'Honor Memorial Day — setup fee waived.';
      },
      body: function () {
        return 'We\'re waiving the $199 setup fee in honor of Memorial Day. Start your plan and get your site launched.';
      }
    },
    {
      id:     'july4',
      start:  new Date(y, 5, 15),           // June 15
      end:    midnight(new Date(y, 6, 4)),   // July 4
      icon:   'fas fa-fire-flame-curved',
      badge:  'Independence Day Special',
      color:  '#1d4ed8',
      border: 'rgba(29,78,216,0.25)',
      headline: function () {
        return 'Your first month is on us — Happy 4th!';
      },
      body: function () {
        return 'Sign up before July 4th and we\'ll credit your entire first month. No setup fee either.';
      }
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
      border: 'rgba(120,81,169,0.25)',
      headline: function () {
        return 'You\'ve worked hard — let us handle your website.';
      },
      body: function () {
        return 'Setup fee waived through Labor Day. Get your business website up before the holiday.';
      }
    },
    {
      id:     'thanksgiving',
      start:  (function () {
        var d = new Date(thanksgiving);
        d.setHours(0, 0, 0, 0);
        return d;
      })(),
      end:    midnight(new Date(y, 10, 30)), // Nov 30
      icon:   'fas fa-drumstick-bite',
      badge:  'Thanksgiving Sale',
      color:  '#b45309',
      border: 'rgba(180,83,9,0.25)',
      headline: function () {
        return 'Thankful for your business — setup fee waived.';
      },
      body: function () {
        return 'This Thanksgiving we\'re waiving the $199 setup fee. Give your business a site to be proud of.';
      }
    },
    {
      id:     'christmas',
      start:  new Date(y, 11, 10),          // Dec 10
      end:    midnight(new Date(y, 11, 25)),  // Dec 25
      icon:   'fas fa-tree',
      badge:  'Christmas Sale',
      color:  '#15803d',
      border: 'rgba(21,128,61,0.25)',
      headline: function () {
        return 'Give your business the gift of a great website.';
      },
      body: function () {
        return 'Setup fee waived through Christmas Day. Start the new year with a professional site ready to go.';
      }
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
      promo.end = new Date(now + 5 * 86400000); // fake 5 days for preview
    }
  } else {
    for (i = 0; i < PROMOS.length; i++) {
      if (now >= PROMOS[i].start.getTime() && now <= PROMOS[i].end.getTime()) {
        promo = PROMOS[i];
        break;
      }
    }
  }
  if (!promo) return;

  var isPreview = !!previewId;

  // ── Dismissal — resets each calendar day ─────────────────────────────────────

  var today = new Date().toISOString().slice(0, 10);
  var lsKey = 'wb-promo-dismissed-' + promo.id + '-' + today;
  if (!isPreview) { try { if (localStorage.getItem(lsKey)) return; } catch (e) {} }

  // ── Build banner ─────────────────────────────────────────────────────────────

  var left = timeLeftLabel(promo.end);
  if (!left) return;

  var bar = document.createElement('div');
  bar.id = 'wb-promo-bar';
  bar.innerHTML =
    '<div class="wbpromo-inner">' +
      '<div class="wbpromo-left">' +
        '<span class="wbpromo-badge"><i class="' + promo.icon + '"></i> ' + promo.badge + '</span>' +
        '<span class="wbpromo-headline">' + promo.headline() + '</span>' +
        '<span class="wbpromo-body">' + promo.body(left) + '</span>' +
      '</div>' +
      '<div class="wbpromo-right">' +
        '<a href="consultation.html" class="wbpromo-cta">Claim offer <i class="fas fa-arrow-right"></i></a>' +
        '<button class="wbpromo-close" id="wbpromo-close-btn" aria-label="Dismiss"><i class="fas fa-xmark"></i></button>' +
      '</div>' +
    '</div>';

  var s = document.createElement('style');
  s.textContent = [
    '#wb-promo-bar{',
      'background:#fff;',
      'border-top:3px solid ' + promo.color + ';',
      'border-bottom:1px solid ' + promo.border + ';',
      'overflow:hidden;max-height:80px;opacity:1;',
      'transition:max-height .4s ease,opacity .35s ease;',
      'box-shadow:0 2px 10px rgba(0,0,0,.06);',
    '}',
    '.wbpromo-inner{',
      'max-width:1100px;margin:0 auto;padding:7px 20px;',
      'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;',
      'font-family:"Poppins",sans-serif;',
    '}',
    '.wbpromo-left{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1;min-width:0;}',
    '.wbpromo-badge{',
      'display:inline-flex;align-items:center;gap:5px;',
      'background:' + promo.color + ';color:#fff;',
      'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;',
      'padding:3px 11px;border-radius:999px;white-space:nowrap;flex-shrink:0;',
    '}',
    '.wbpromo-headline{font-size:15px;font-weight:700;color:#0f1228;white-space:nowrap;flex-shrink:0;}',
    '.wbpromo-body{font-size:14px;color:#4b5563;line-height:1.4;min-width:0;}',
    '.wbpromo-body strong{color:#0f1228;font-weight:600;}',
    '.wbpromo-right{display:flex;align-items:center;gap:10px;flex-shrink:0;}',
    '.wbpromo-cta{',
      'display:inline-flex;align-items:center;gap:7px;',
      'background:' + promo.color + ';color:#fff !important;',
      'font-size:14px;font-weight:700;',
      'padding:7px 16px;border-radius:10px;',
      'text-decoration:none !important;white-space:nowrap;',
      'transition:opacity .15s,transform .15s;',
    '}',
    '.wbpromo-cta:hover{opacity:.88;transform:translateY(-1px);}',
    '.wbpromo-close{',
      'background:none;border:none;cursor:pointer;',
      'color:#9ca3af;font-size:14px;padding:5px 7px;border-radius:6px;line-height:1;',
      'transition:color .14s,background .14s;',
    '}',
    '.wbpromo-close:hover{color:#374151;background:rgba(0,0,0,.06);}',
    '@media(max-width:640px){',
      '.wbpromo-headline{display:none;}',
      '.wbpromo-body{font-size:13px;}',
      '.wbpromo-cta{font-size:13px;padding:6px 12px;}',
    '}'
  ].join('');
  document.head.appendChild(s);

  // ── Insert after nav ──────────────────────────────────────────────────────────

  function insert() {
    var nav = document.querySelector('.nav-wrap');
    if (nav && nav.parentNode) {
      nav.parentNode.insertBefore(bar, nav.nextSibling);
    } else {
      document.body.prepend(bar);
    }
    var btn = document.getElementById('wbpromo-close-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        bar.style.maxHeight = '0';
        bar.style.opacity = '0';
        if (!isPreview) { try { localStorage.setItem(lsKey, '1'); } catch (e) {} }
        setTimeout(function () { if (bar.parentNode) bar.parentNode.removeChild(bar); }, 420);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insert);
  } else {
    insert();
  }

  // ── Live countdown — updates every 60s, auto-removes when expired ─────────────

  setInterval(function () {
    var newLeft = timeLeftLabel(promo.end);
    if (!newLeft) {
      bar.style.maxHeight = '0';
      bar.style.opacity = '0';
      setTimeout(function () { if (bar.parentNode) bar.parentNode.removeChild(bar); }, 420);
      return;
    }
    var bodyEl = bar.querySelector('.wbpromo-body');
    var headEl = bar.querySelector('.wbpromo-headline');
    if (bodyEl) bodyEl.innerHTML = promo.body(newLeft);
    if (headEl) headEl.textContent = promo.headline();
  }, 60000);

})();
