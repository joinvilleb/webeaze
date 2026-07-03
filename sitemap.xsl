<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"
  exclude-result-prefixes="sm">

<xsl:output method="html" encoding="UTF-8" indent="yes" doctype-system="about:legacy-compat"/>

<xsl:template match="/">
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Sitemap &#8212; WebEaze</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&amp;display=swap" rel="stylesheet"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0; font-family: 'Poppins', sans-serif;
      background: #f5f6fa; color: #1a1a2e;
      -webkit-font-smoothing: antialiased;
    }
    a { text-decoration: none; color: inherit; }

    .site-header {
      background: #ffffff;
      border-bottom: 1px solid rgba(0,0,0,.08);
      padding: 14px 24px;
      display: flex; align-items: center; gap: 10px;
      box-shadow: 0 1px 4px rgba(0,0,0,.05);
      position: sticky; top: 0; z-index: 10;
    }
    .site-header img { height: 28px; }
    .site-header span { font-weight: 700; font-size: 1rem; color: #1a1a2e; }
    .site-header-back {
      margin-left: auto;
      font-size: .82rem; font-weight: 600; color: #7851a9;
      display: inline-flex; align-items: center; gap: 5px;
      padding: 7px 14px; border: 1.5px solid rgba(120,81,169,.25);
      border-radius: 8px; transition: background .15s;
      white-space: nowrap;
    }
    .site-header-back:hover { background: rgba(120,81,169,.07); }

    .hero-strip {
      background: #ffffff;
      border-bottom: 1px solid rgba(0,0,0,.07);
      padding: 44px 24px 36px;
      text-align: center;
    }
    .hero-strip h1 {
      font-size: clamp(1.6rem, 4vw, 2.4rem);
      font-weight: 700; letter-spacing: -.04em; margin: 0 0 8px;
      color: #1a1a2e;
    }
    .hero-strip h1 span {
      background: linear-gradient(135deg, #7851a9, #a07dd0);
      -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    }
    .hero-strip p { color: #6b7280; font-size: .93rem; margin: 0; }
    .count-badge {
      display: inline-flex; align-items: center; gap: 6px;
      margin-top: 16px;
      background: rgba(120,81,169,.07); border: 1px solid rgba(120,81,169,.18);
      border-radius: 50px; padding: 7px 18px;
      font-size: .83rem; color: #6b7280;
    }
    .count-badge strong { color: #7851a9; }

    .page-wrap {
      max-width: 940px; margin: 0 auto; padding: 40px 20px 64px;
    }

    .cat-section { margin-bottom: 40px; }
    .cat-header {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 12px; padding-bottom: 10px;
      border-bottom: 1px solid rgba(0,0,0,.07);
    }
    .cat-title {
      font-size: .71rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: .1em;
      color: #7851a9;
    }
    .cat-count {
      font-size: .71rem; color: #9ca3af;
      background: #eceef8; border: 1px solid rgba(0,0,0,.07);
      border-radius: 20px; padding: 2px 9px;
    }
    .cat-header { cursor: pointer; user-select: none; }
    .cat-header:hover .cat-title { color: #5f3d94; }
    .cat-chevron {
      margin-left: auto; width: 18px; height: 18px; flex: none;
      color: #9ca3af; transition: transform .2s;
    }
    .cat-section:not(.open) .cat-chevron { transform: rotate(-90deg); }
    .cat-section:not(.open) .link-grid { display: none; }
    .expand-all {
      display: inline-flex; align-items: center; gap: 6px;
      margin: 0 auto 26px; cursor: pointer;
      font-size: .8rem; font-weight: 600; color: #7851a9;
      background: rgba(120,81,169,.07); border: 1px solid rgba(120,81,169,.18);
      border-radius: 8px; padding: 8px 16px;
    }
    .expand-all:hover { background: rgba(120,81,169,.12); }

    .link-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
    }
    .link-card {
      display: block;
      background: #ffffff;
      border: 1px solid rgba(0,0,0,.08);
      border-radius: 12px;
      padding: 14px 16px;
      transition: border-color .18s, box-shadow .18s, transform .18s;
      text-decoration: none;
      min-height: 56px;
    }
    .link-card:hover {
      border-color: #7851a9;
      box-shadow: 0 3px 14px rgba(120,81,169,.12);
      transform: translateY(-1px);
    }
    .link-card-name {
      display: block; font-size: 13px; font-weight: 600;
      color: #1a1a2e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .link-card-path {
      display: block; font-size: 11px; color: #9ca3af; margin-top: 3px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .sitemap-footer {
      text-align: center; padding: 22px 20px 36px;
      border-top: 1px solid rgba(0,0,0,.07);
      color: #9ca3af; font-size: .82rem;
    }
    .sitemap-footer a { color: #7851a9; }
    .sitemap-footer a:hover { text-decoration: underline; }

    @media (max-width: 640px) {
      .hero-strip { padding: 32px 16px 28px; }
      .page-wrap { padding: 24px 14px 48px; }
      .link-grid { grid-template-columns: 1fr 1fr; gap: 8px; }
      .link-card { padding: 13px 14px; min-height: 52px; }
    }
    @media (max-width: 400px) {
      .link-grid { grid-template-columns: 1fr; }
      .link-card { min-height: 48px; }
    }
  </style>
</head>
<body>

  <header class="site-header">
    <img src="images/webeaze-transparent-copy.png" alt="WebEaze"/>
    <span>WebEaze</span>
    <a class="site-header-back" href="/">&#8592; Back to site</a>
  </header>

  <div class="hero-strip">
    <h1>WebEaze <span>Site Map</span></h1>
    <p>All publicly indexed pages on webeaze.io</p>
    <div class="count-badge">
      <strong><xsl:value-of select="count(sm:urlset/sm:url)"/></strong>
      pages indexed
    </div>
  </div>

  <!-- URL data rendered by XSLT, read by JS -->
  <ul id="url-data" style="display:none">
    <xsl:for-each select="sm:urlset/sm:url">
      <li><a href="{sm:loc}">&#160;</a></li>
    </xsl:for-each>
  </ul>

  <div class="page-wrap" id="pageWrap"></div>

  <div class="sitemap-footer">
    <p>&#169; WebEaze &#183; <a href="https://www.webeaze.io">webeaze.io</a> &#183; Made in Delaware, USA &#127482;&#127480;</p>
  </div>

  <script>
  //<![CDATA[
  (function() {
    var links = document.querySelectorAll('#url-data a');
    var URLS  = [];
    for (var n = 0; n < links.length; n++) {
      URLS.push(links[n].getAttribute('href'));
    }

    var NAMES = {
      '/': 'Home',
      '/pricing': 'Pricing',
      '/services': 'Services',
      '/consultation': 'Free Consultation',
      '/faq': 'FAQ',
      '/about': 'About Us',
      '/contact-us': 'Contact',
      '/samples': 'Our Work',
      '/manage': 'Website Management',
      '/one-time-project': 'One-Time Projects',
      '/seo': 'Local SEO',
      '/google-business-management': 'Google Business Profile',
      '/maintenance': 'Unlimited Updates',
      '/ai': 'AI Chatbot',
      '/ads': 'Ad Management',
      '/plan-guide': 'Plan Guide',
      '/providers': 'Providers',
      '/benefits': 'Benefits',
      '/reports': 'Reports',
      '/website-setup-package': 'Website Setup Package',
      '/domains': 'Domains',
      '/blog': 'Blog Home',
      '/blog/introducing-the-webeaze-client-portal': 'Introducing the WebEaze Client Portal',
      '/blog/does-my-small-business-need-a-website': 'Do I Need a Website?',
      '/blog/small-business-website-cost': 'Website Cost Guide',
      '/blog/what-is-local-seo': 'What Is Local SEO?',
      '/blog/web-design-for-restaurants': 'Web Design for Restaurants',
      '/blog/google-business-profile-vs-website': 'Google Business vs Website',
      '/blog/how-to-get-on-google-maps': 'How to Get on Google Maps',
      '/blog/small-business-website-checklist': 'Website Checklist',
      '/blog/why-not-showing-on-google': 'Why Not Showing on Google',
      '/website-request': 'Submit a Request',
      '/help': 'Help Center',
      '/referral': 'Referral Program',
      '/my-plan': 'My Plan',
      '/status': 'Support Status',
      '/fee-schedule': 'Fee Schedule',
      '/documents': 'Documents',
      '/refund-policy': 'Refund Policy',
      '/cancellation-policy': 'Cancellation Policy',
      '/acceptable-use-policy': 'Acceptable Use',
      '/cookies': 'Cookie Policy',
      '/terms': 'Terms of Service',
      '/accessibility': 'Accessibility'
    };

    var CORE = ['/', '/pricing', '/services', '/consultation', '/faq', '/about', '/contact-us', '/samples'];
    var SVCS = ['/manage', '/one-time-project', '/seo', '/google-business-management', '/maintenance', '/ai', '/ads', '/plan-guide', '/providers', '/benefits', '/reports', '/website-setup-package', '/domains'];

    var CATS = [
      { label: 'Core Pages',             open: true,  match: function(p) { return CORE.indexOf(p) !== -1; } },
      { label: 'Services',               open: true,  match: function(p) { return SVCS.indexOf(p) !== -1; } },
      { label: 'Blog',                   open: true,  match: function(p) { return p.indexOf('/blog') === 0; } },
      { label: 'Web Design by Location', open: false, match: function(p) { return p.indexOf('/web-design-') === 0; } },
      { label: 'Help Center',            open: false, match: function(p) { return p === '/help' || p.indexOf('/help/') === 0; } },
      { label: 'Support and Policies',   open: true,  match: function(p) { return true; } }
    ];

    function toName(p) {
      if (NAMES[p]) return NAMES[p];
      return p.replace(/\/$/, '')            // drop trailing slash (help article dirs)
              .replace(/^\/help\//, '')      // help article slug
              .replace(/^\/web-design-/, '') // location pages
              .replace(/^\//, '')
              .replace(/-/g, ' ')
              .replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    }

    var buckets = CATS.map(function(c) { return { cat: c, items: [] }; });

    URLS.forEach(function(loc) {
      var p = loc.replace('https://webeaze.io', '') || '/';
      buckets.some(function(b) {
        if (b.cat.match(p)) { b.items.push({ loc: loc, path: p }); return true; }
      });
    });

    var wrap = document.getElementById('pageWrap');

    var CHEVRON = '<svg class="cat-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

    var toggleAll = document.createElement('div');
    toggleAll.className = 'expand-all';
    toggleAll.textContent = 'Expand all';
    var allOpen = false;
    toggleAll.addEventListener('click', function() {
      allOpen = !allOpen;
      var secs = wrap.querySelectorAll('.cat-section');
      for (var i = 0; i < secs.length; i++) { secs[i].classList.toggle('open', allOpen); }
      toggleAll.textContent = allOpen ? 'Collapse all' : 'Expand all';
    });
    wrap.appendChild(toggleAll);

    var sections = [];
    buckets.forEach(function(b) {
      if (!b.items.length) return;

      var sec = document.createElement('div');
      sec.className = 'cat-section' + (b.cat.open ? ' open' : '');
      sections.push(sec);

      var hdr = document.createElement('div');
      hdr.className = 'cat-header';
      hdr.innerHTML = '<span class="cat-title">' + b.cat.label + '</span>'
                    + '<span class="cat-count">' + b.items.length + '</span>'
                    + CHEVRON;
      hdr.addEventListener('click', function() { sec.classList.toggle('open'); });
      sec.appendChild(hdr);

      var grid = document.createElement('div');
      grid.className = 'link-grid';

      b.items.forEach(function(item) {
        var name = toName(item.path);
        var card = document.createElement('a');
        card.className = 'link-card';
        card.href = item.loc;
        card.innerHTML = '<span class="link-card-name">' + name + '</span>'
                       + '<span class="link-card-path">' + item.path + '</span>';
        grid.appendChild(card);
      });

      sec.appendChild(grid);
      wrap.appendChild(sec);
    });
  })();
  //]]>
  </script>

</body>
</html>
</xsl:template>

</xsl:stylesheet>
