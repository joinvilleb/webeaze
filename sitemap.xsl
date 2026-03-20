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
      background: #050509; color: #fff;
      -webkit-font-smoothing: antialiased;
    }
    a { text-decoration: none; color: inherit; }

    /* Header */
    .site-header {
      background: rgba(5,5,9,.96);
      border-bottom: 1px solid rgba(255,255,255,.08);
      padding: 18px 32px;
      display: flex; align-items: center; gap: 12px;
    }
    .site-header img { height: 34px; }
    .site-header span { font-weight: 700; font-size: 1.15rem; color: #fff; }

    /* Hero strip */
    .hero-strip {
      background: linear-gradient(135deg, rgba(120,81,169,.15) 0%, rgba(255,215,0,.06) 100%);
      border-bottom: 1px solid rgba(255,255,255,.07);
      padding: 48px 32px 40px;
      text-align: center;
    }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 7px;
      background: rgba(255,215,0,.1); border: 1px solid rgba(255,215,0,.28);
      border-radius: 50px; padding: 6px 16px;
      font-size: .75rem; font-weight: 600; color: #ffd700;
      letter-spacing: .06em; text-transform: uppercase; margin-bottom: 14px;
    }
    .hero-strip h1 {
      font-size: clamp(1.7rem, 4vw, 2.4rem);
      font-weight: 600; letter-spacing: -.025em; margin: 0 0 8px;
    }
    .hero-strip h1 span {
      background: linear-gradient(135deg, #ffd700, #ffe97a);
      -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    }
    .hero-strip p { color: #a0a6c0; font-size: .97rem; margin: 0; }

    /* Count badge */
    .count-badge {
      display: inline-flex; align-items: center; gap: 8px;
      margin-top: 18px;
      background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1);
      border-radius: 50px; padding: 8px 20px;
      font-size: .85rem; color: rgba(255,255,255,.7);
    }
    .count-badge strong { color: #ffd700; }

    /* Table area */
    .table-wrap {
      max-width: 860px; margin: 0 auto; padding: 40px 24px 64px;
    }
    table {
      width: 100%; border-collapse: collapse;
    }
    thead th {
      text-align: left; font-size: .72rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: .08em;
      color: #a0a6c0; padding: 10px 16px;
      border-bottom: 1px solid rgba(255,255,255,.1);
    }
    tbody tr {
      border-bottom: 1px solid rgba(255,255,255,.05);
      transition: background .15s;
    }
    tbody tr:last-child { border-bottom: none; }
    tbody tr:hover { background: rgba(255,255,255,.03); }
    td {
      padding: 13px 16px; font-size: .88rem; vertical-align: middle;
    }
    td.num { color: #a0a6c0; width: 48px; }
    td.url a {
      color: #ffd700; transition: color .2s;
      word-break: break-all;
    }
    td.url a:hover { color: #ffe97a; }
    td.path { color: rgba(255,255,255,.45); font-size: .8rem; }

    /* Footer */
    .sitemap-footer {
      text-align: center; padding: 28px 20px 40px;
      border-top: 1px solid rgba(255,255,255,.07);
      color: #6b7280; font-size: .82rem;
    }
    .sitemap-footer a { color: #ffd700; }
    .sitemap-footer a:hover { text-decoration: underline; }

    @media (max-width: 540px) {
      .site-header { padding: 14px 20px; }
      .hero-strip { padding: 36px 20px 30px; }
      .table-wrap { padding: 28px 12px 48px; }
      td { padding: 11px 10px; }
      td.path { display: none; }
    }
  </style>
</head>
<body>

  <header class="site-header">
    <img src="images/webeaze-transparent copy.png" alt="WebEaze"/>
    <span>WebEaze</span>
  </header>

  <div class="hero-strip">
    <div class="eyebrow">&#128205; XML Sitemap</div>
    <h1>WebEaze <span>Site Map</span></h1>
    <p>All publicly indexed pages on webeaze.io</p>
    <div class="count-badge">
      <strong><xsl:value-of select="count(sm:urlset/sm:url)"/></strong>
      pages indexed
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th class="num">#</th>
          <th>URL</th>
          <th>Path</th>
        </tr>
      </thead>
      <tbody>
        <xsl:for-each select="sm:urlset/sm:url">
          <xsl:sort select="sm:loc"/>
          <tr>
            <td class="num"><xsl:value-of select="position()"/></td>
            <td class="url">
              <a href="{sm:loc}"><xsl:value-of select="sm:loc"/></a>
            </td>
            <td class="path">
              <xsl:value-of select="substring-after(sm:loc, 'webeaze.io')"/>
            </td>
          </tr>
        </xsl:for-each>
      </tbody>
    </table>
  </div>

  <div class="sitemap-footer">
    <p>&#169; WebEaze &#183; <a href="https://www.webeaze.io">webeaze.io</a> &#183; Made in Delaware, USA &#127482;&#127480;</p>
  </div>

</body>
</html>
</xsl:template>

</xsl:stylesheet>
