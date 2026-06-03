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
  <title>Sitemap — WebEaze</title>
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
      padding: 16px 32px;
      display: flex; align-items: center; gap: 12px;
      box-shadow: 0 1px 4px rgba(0,0,0,.05);
    }
    .site-header img { height: 32px; }
    .site-header span { font-weight: 700; font-size: 1.1rem; color: #1a1a2e; }

    .hero-strip {
      background: #ffffff;
      border-bottom: 1px solid rgba(0,0,0,.07);
      padding: 52px 32px 44px;
      text-align: center;
    }
    .hero-strip h1 {
      font-size: clamp(1.75rem, 4vw, 2.5rem);
      font-weight: 700; letter-spacing: -.04em; margin: 0 0 10px;
      color: #1a1a2e;
    }
    .hero-strip h1 span {
      background: linear-gradient(135deg, #7851a9, #a07dd0);
      -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    }
    .hero-strip p { color: #6b7280; font-size: .97rem; margin: 0; }
    .count-badge {
      display: inline-flex; align-items: center; gap: 6px;
      margin-top: 18px;
      background: rgba(120,81,169,.07); border: 1px solid rgba(120,81,169,.18);
      border-radius: 50px; padding: 7px 18px;
      font-size: .85rem; color: #6b7280;
    }
    .count-badge strong { color: #7851a9; }

    .page-wrap {
      max-width: 940px; margin: 0 auto; padding: 44px 24px 72px;
    }

    .cat-section { margin-bottom: 44px; }
    .cat-header {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 14px; padding-bottom: 12px;
      border-bottom: 1px solid rgba(0,0,0,.07);
    }
    .cat-icon {
      width: 30px; height: 30px; border-radius: 8px;
      background: rgba(120,81,169,.1);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; flex-shrink: 0;
    }
    .cat-title {
      font-size: .72rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: .1em;
      color: #7851a9;
    }
    .cat-count {
      margin-left: 4px;
      font-size: .72rem; color: #9ca3af;
      background: #eceef8; border: 1px solid rgba(0,0,0,.07);
      border-radius: 20px; padding: 2px 9px;
    }

    .link-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
      gap: 10px;
    }
    .link-card {
      display: flex; align-items: center; gap: 11px;
      background: #ffffff;
      border: 1px solid rgba(0,0,0,.08);
      border-radius: 12px;
      padding: 13px 15px;
      transition: border-color .18s, box-shadow .18s, transform .18s;
      text-decoration: none;
    }
    .link-card:hover {
      border-color: #7851a9;
      box-shadow: 0 3px 14px rgba(120,81,169,.12);
      transform: translateY(-1px);
    }
    .link-card-icon {
      width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
      background: rgba(120,81,169,.08);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; color: #7851a9;
      font-weight: 600;
    }
    .link-card-text { min-width: 0; }
    .link-card-name {
      display: block; font-size: 13px; font-weight: 600;
      color: #1a1a2e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .link-card-path {
      display: block; font-size: 11px; color: #9ca3af; margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .sitemap-footer {
      text-align: center; padding: 24px 20px 36px;
      border-top: 1px solid rgba(0,0,0,.07);
      color: #9ca3af; font-size: .82rem;
    }
    .sitemap-footer a { color: #7851a9; }
    .sitemap-footer a:hover { text-decoration: underline; }

    @media (max-width: 640px) {
      .site-header { padding: 14px 20px; }
      .hero-strip { padding: 36px 20px 32px; }
      .page-wrap { padding: 28px 16px 52px; }
      .link-grid { grid-template-columns: 1fr 1fr; gap: 8px; }
    }
    @media (max-width: 380px) {
      .link-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <header class="site-header">
    <img src="images/webeaze-transparent copy.png" alt="WebEaze"/>
    <span>WebEaze</span>
  </header>

  <div class="hero-strip">
    <h1>WebEaze <span>Site Map</span></h1>
    <p>All publicly indexed pages on webeaze.io</p>
    <div class="count-badge">
      <strong><xsl:value-of select="count(sm:urlset/sm:url)"/></strong>
      pages indexed
    </div>
  </div>

  <div class="page-wrap" id="pageWrap"></div>

  <div class="sitemap-footer">
    <p>&#169; WebEaze &#183; <a href="https://www.webeaze.io">webeaze.io</a> &#183; Made in Delaware, USA &#127482;&#127480;</p>
  </div>

  <script>
  (function() {
    var URLS = [
      <xsl:for-each select="sm:urlset/sm:url">{"loc":"<xsl:value-of select="sm:loc"/>","pri":"<xsl:value-of select="sm:priority"/>"}<xsl:if test="position() != last()">,</xsl:if>
      </xsl:for-each>
    ];

    var NAMES = {
      '/': 'Home', '/pricing': 'Pricing', '/services': 'Services',
      '/consultation': 'Free Consultation', '/faq': 'FAQ', '/about': 'About Us',
      '/contact-us': 'Contact', '/samples': 'Our Work',
      '/seo': 'SEO', '/google-business-management': 'Google Business',
      '/maintenance': 'Maintenance', '/ai': 'AI Chatbot', '/ads': 'Ad Management',
      '/plan-guide': 'Plan Guide', '/providers': 'Providers', '/benefits': 'Benefits',
      '/reports': 'Reports', '/website-setup-package': 'Website Setup Package',
      '/domains': 'Domains',
      '/website-request': 'Submit a Request', '/help': 'Help Center',
      '/referral': 'Referral Program', '/my-plan': 'My Plan', '/status': 'Support Status',
      '/fee-schedule': 'Fee Schedule', '/documents': 'Documents',
      '/refund-policy': 'Refund Policy', '/cancellation-policy': 'Cancellation Policy',
      '/acceptable-use-policy': 'Acceptable Use', '/cookies': 'Cookie Policy',
      '/terms': 'Terms of Service', '/accessibility': 'Accessibility'
    };

    var CORE = ['/', '/pricing', '/services', '/consultation', '/faq', '/about', '/contact-us', '/samples'];
    var SVCS = ['/seo', '/google-business-management', '/maintenance', '/ai', '/ads', '/plan-guide', '/providers', '/benefits', '/reports', '/website-setup-package', '/domains'];

    var CATS = [
      { label: 'Core Pages',               icon: '&#127968;', match: function(p) { return CORE.indexOf(p) !== -1; } },
      { label: 'Services',                  icon: '&#9889;',   match: function(p) { return SVCS.indexOf(p) !== -1; } },
      { label: 'Web Design by Location',    icon: '&#128205;', match: function(p) { return p.indexOf('/web-design-') === 0; } },
      { label: 'Support &amp; Policies',   icon: '&#128203;', match: function(p) { return true; } }
    ];

    function toName(p) {
      if (NAMES[p]) return NAMES[p];
      return p.replace(/^\/web-design-/, '')
              .replace(/-/g, ' ')
              .replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    }

    function toInitial(name) {
      return name.charAt(0).toUpperCase();
    }

    var buckets = CATS.map(function(c) { return { cat: c, items: [] }; });

    URLS.forEach(function(u) {
      var p = u.loc.replace('https://webeaze.io', '') || '/';
      for (var i = 0; i < buckets.length; i++) {
        if (buckets[i].cat.match(p)) {
          buckets[i].items.push({ loc: u.loc, path: p });
          return;
        }
      }
    });

    var html = '';
    buckets.forEach(function(b) {
      if (!b.items.length) return;
      html += '<div class="cat-section">';
      html += '<div class="cat-header">';
      html += '<div class="cat-icon">' + b.cat.icon + '</div>';
      html += '<span class="cat-title">' + b.cat.label + '</span>';
      html += '<span class="cat-count">' + b.items.length + '</span>';
      html += '</div>';
      html += '<div class="link-grid">';
      b.items.forEach(function(item) {
        var name = toName(item.path);
        html += '<a class="link-card" href="' + item.loc + '">';
        html += '<div class="link-card-icon">' + toInitial(name) + '</div>';
        html += '<div class="link-card-text">';
        html += '<span class="link-card-name">' + name + '</span>';
        html += '<span class="link-card-path">' + item.path + '</span>';
        html += '</div></a>';
      });
      html += '</div></div>';
    });

    document.getElementById('pageWrap').innerHTML = html;
  })();
  </script>

</body>
</html>
</xsl:template>

</xsl:stylesheet>
