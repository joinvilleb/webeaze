/**
 * WebEaze Personalization Engine
 * Inserts a contextual banner below the nav based on:
 *   1. URL params  (utm_source, from, via)
 *   2. document.referrer (social, search, internal pages)
 *   3. Device type (mobile vs desktop)
 *
 * Each page can configure window.WB_PAGE_CTX before loading this script.
 */
(function () {
  'use strict';

  // Dismissed already this session on this page?
  var SESSION_KEY = 'wb-ctx:' + (window.location.pathname.split('/').pop() || 'index.html');
  if (sessionStorage.getItem(SESSION_KEY)) return;

  var PAGE_CTX = window.WB_PAGE_CTX || {};
  var isMobile = window.innerWidth < 768;

  // ── Detect signals ────────────────────────────────────────────────────────────
  var params  = new URLSearchParams(window.location.search);
  var utmSrc  = (params.get('utm_source') || params.get('from') || params.get('via') || '').toLowerCase();
  var utmMed  = (params.get('utm_medium') || '').toLowerCase();

  var refHost = '', refPage = '';
  try {
    var u = new URL(document.referrer);
    refHost = u.hostname.toLowerCase();
    refPage = u.pathname.split('/').pop() || 'index.html';
  } catch (e) {}

  // ── Resolve context ───────────────────────────────────────────────────────────
  var ctx = null;
  var brandPurple = '#7851a9';

  function social(icon, color, bg, border, msg, note, links) {
    return { icon: icon, color: color, bg: bg, border: border, msg: msg, note: note, links: links };
  }

  if (refHost.includes('facebook.com') || refHost.includes('fb.com') || utmSrc.includes('facebook') || utmSrc === 'fb') {
    ctx = social(
      'fab fa-facebook-f', '#1877f2', 'rgba(24,119,242,0.06)', 'rgba(24,119,242,0.16)',
      'Glad you found us on Facebook.',
      isMobile ? 'We build and manage websites for small businesses.' : 'We build and manage professional websites for small businesses, end to end.',
      PAGE_CTX.facebook || [{ text: 'See our work', href: 'samples.html' }, { text: 'Get a free mockup', href: 'consultation.html' }]
    );
  } else if (refHost.includes('instagram.com') || utmSrc.includes('instagram') || utmSrc === 'ig') {
    ctx = social(
      'fab fa-instagram', '#c13584', 'rgba(193,53,132,0.06)', 'rgba(193,53,132,0.16)',
      'Welcome from Instagram.',
      isMobile ? 'We build websites for businesses like yours.' : "We design and manage websites so business owners don't have to think about it.",
      PAGE_CTX.instagram || [{ text: 'View our work', href: 'samples.html' }, { text: 'Request a free mockup', href: 'consultation.html' }]
    );
  } else if (refHost.includes('linkedin.com') || utmSrc.includes('linkedin')) {
    ctx = social(
      'fab fa-linkedin-in', '#0a66c2', 'rgba(10,102,194,0.06)', 'rgba(10,102,194,0.16)',
      'Welcome from LinkedIn.',
      isMobile ? 'We handle everything your website needs.' : "We handle everything your website needs — design, hosting, updates, and support.",
      PAGE_CTX.linkedin || [{ text: 'About WebEaze', href: 'about.html' }, { text: 'View pricing', href: 'pricing.html' }]
    );
  } else if (refHost.includes('google.com') || utmSrc.includes('google') || utmMed === 'cpc' || utmMed === 'organic') {
    ctx = social(
      'fas fa-magnifying-glass', '#4285f4', 'rgba(66,133,244,0.06)', 'rgba(66,133,244,0.16)',
      'Found us on Google?',
      isMobile ? "Here's a quick look at what we do." : "Here's a quick overview of our services and how we help small businesses online.",
      PAGE_CTX.google || [{ text: 'Our services', href: 'services.html' }, { text: 'FAQ', href: 'faq.html' }]
    );
  } else if (refPage && refHost.includes('webeaze') && PAGE_CTX.internal && PAGE_CTX.internal[refPage]) {
    var inCtx = PAGE_CTX.internal[refPage];
    ctx = {
      icon:   inCtx.icon   || 'fas fa-arrow-right-long',
      color:  inCtx.color  || brandPurple,
      bg:     inCtx.bg     || 'rgba(120,81,169,0.06)',
      border: inCtx.border || 'rgba(120,81,169,0.18)',
      msg:    inCtx.msg    || '',
      note:   isMobile ? (inCtx.noteMobile || inCtx.note || '') : (inCtx.note || ''),
      links:  inCtx.links  || []
    };
  }

  if (!ctx || !ctx.msg) return;

  // ── Build HTML ────────────────────────────────────────────────────────────────
  var linksHtml = (ctx.links || []).map(function (l) {
    return '<a href="' + l.href + '" class="wbp-link">' + l.text + '</a>';
  }).join('');

  var bar = document.createElement('div');
  bar.id = 'wb-personalize';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  bar.innerHTML =
    '<div class="wbp-inner">' +
      '<i class="' + ctx.icon + ' wbp-icon"></i>' +
      '<div class="wbp-text">' +
        '<strong>' + ctx.msg + '</strong>' +
        (ctx.note ? ' <span class="wbp-note">' + ctx.note + '</span>' : '') +
      '</div>' +
      (linksHtml ? '<div class="wbp-actions">' + linksHtml + '</div>' : '') +
      '<button class="wbp-close" aria-label="Dismiss personalisation banner" id="wbp-dismiss-btn">' +
        '<i class="fas fa-xmark"></i>' +
      '</button>' +
    '</div>';

  // ── Styles ────────────────────────────────────────────────────────────────────
  var s = document.createElement('style');
  s.textContent = [
    '#wb-personalize{',
      'max-height:72px;overflow:hidden;opacity:1;',
      'transition:max-height .35s ease,opacity .3s ease;',
      'background:' + ctx.bg + ';',
      'border-bottom:1px solid ' + ctx.border + ';',
    '}',
    '.wbp-inner{',
      'max-width:1100px;margin:0 auto;padding:9px 20px;',
      'display:flex;align-items:center;gap:11px;flex-wrap:wrap;',
      'font-family:"Poppins",sans-serif;font-size:13.5px;color:#0f1228;',
    '}',
    '.wbp-icon{color:' + ctx.color + ';font-size:14px;flex-shrink:0;}',
    '.wbp-text{flex:1;line-height:1.5;}',
    '.wbp-text strong{font-weight:600;}',
    '.wbp-note{color:#4b5563;font-weight:400;}',
    '.wbp-actions{display:flex;gap:7px;flex-wrap:wrap;}',
    '.wbp-link{',
      'display:inline-flex;align-items:center;',
      'padding:4px 13px;border-radius:999px;',
      'border:1px solid ' + ctx.border + ';',
      'background:rgba(255,255,255,.7);',
      'color:' + ctx.color + ';',
      'font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap;',
      'transition:background .14s,box-shadow .14s;',
    '}',
    '.wbp-link:hover{background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.08);text-decoration:none;color:' + ctx.color + ';}',
    '.wbp-close{',
      'background:none;border:none;cursor:pointer;',
      'color:#9ca3af;font-size:13px;padding:4px 7px;border-radius:6px;line-height:1;flex-shrink:0;',
      'transition:color .14s,background .14s;',
    '}',
    '.wbp-close:hover{color:#374151;background:rgba(0,0,0,.06);}',
    '@media(max-width:600px){',
      '.wbp-inner{padding:8px 14px;font-size:12.5px;gap:8px;}',
      '.wbp-actions{display:none;}',
    '}'
  ].join('');
  document.head.appendChild(s);

  // ── Insert after nav ──────────────────────────────────────────────────────────
  function insert() {
    var nav = document.querySelector('.nav-wrap') || document.querySelector('nav');
    if (nav && nav.parentNode) {
      nav.parentNode.insertBefore(bar, nav.nextSibling);
    } else {
      document.body.prepend(bar);
    }
    // Wire dismiss
    var btn = document.getElementById('wbp-dismiss-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        bar.style.maxHeight = '0';
        bar.style.opacity = '0';
        sessionStorage.setItem(SESSION_KEY, '1');
        setTimeout(function () { if (bar.parentNode) bar.parentNode.removeChild(bar); }, 380);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insert);
  } else {
    insert();
  }

})();
