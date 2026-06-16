#!/usr/bin/env python3
"""Replace old Bootstrap nav-wrap with new custom wb-header across all pages."""

import os
import re
import glob

ROOT = os.path.dirname(os.path.abspath(__file__))

ROOT_NAV = """\
<header class="wb-header" id="wb-header" role="banner">
  <div class="wb-nav-inner">
    <a class="wb-logo" href="index.html">
      <img loading="eager" src="images/webeaze-transparent-copy.png" alt="WebEaze" width="428" height="493">
      <strong class="wb-logo-word">WebEaze</strong>
    </a>
    <nav class="wb-nav" aria-label="Primary navigation">
      <div class="wb-nav-item wb-has-dropdown">
        <button class="wb-nav-link wb-dropdown-btn" aria-expanded="false" aria-haspopup="true" type="button">Our Services <i class="fas fa-chevron-down wb-chevron"></i></button>
        <div class="wb-dropdown" role="menu">
          <a class="wb-dd-item" href="services.html" role="menuitem"><i class="fas fa-th-large"></i> All Services</a>
          <div class="wb-dd-divider"></div>
          <a class="wb-dd-item" href="manage.html" role="menuitem"><i class="fas fa-globe"></i> Website Design &amp; Management</a>
          <a class="wb-dd-item" href="maintenance.html" role="menuitem"><i class="fas fa-sync-alt"></i> Unlimited Updates</a>
          <a class="wb-dd-item" href="seo.html" role="menuitem"><i class="fas fa-search"></i> Local SEO</a>
          <a class="wb-dd-item" href="google-business-management.html" role="menuitem"><i class="fab fa-google"></i> Google Business Profile</a>
          <a class="wb-dd-item" href="ai.html" role="menuitem"><i class="fas fa-robot"></i> AI Chatbot</a>
          <a class="wb-dd-item" href="ads.html" role="menuitem"><i class="fas fa-ad"></i> Ad Management</a>
          <a class="wb-dd-item" href="one-time-project.html" role="menuitem"><i class="fas fa-hammer"></i> One-Time Projects</a>
        </div>
      </div>
      <a class="wb-nav-link" href="pricing.html">Pricing</a>
      <a class="wb-nav-link" href="faq.html">FAQ</a>
      <a class="wb-nav-link" href="blog.html">Blog</a>
      <a class="wb-nav-link" href="help.html">Help</a>
      <a class="wb-nav-link" href="contact-us.html">Contact</a>
    </nav>
    <div class="wb-nav-actions">
      <a id="client-portal-btn" class="wb-portal-btn" href="client-start.html"><i class="fas fa-user"></i> <span id="client-portal-label">Client Portal</span></a>
      <button class="wb-hamburger" id="wb-hamburger" aria-label="Open menu" aria-expanded="false" aria-controls="wb-mobile-menu" type="button">
        <span class="wb-bar"></span><span class="wb-bar"></span><span class="wb-bar"></span>
      </button>
    </div>
  </div>
  <div class="wb-mobile-menu" id="wb-mobile-menu" aria-hidden="true">
    <div class="wb-mob-inner">
      <a class="wb-mob-link" href="services.html"><i class="fas fa-th-large"></i> All Services</a>
      <a class="wb-mob-link wb-mob-sub" href="manage.html"><i class="fas fa-globe"></i> Website Design &amp; Management</a>
      <a class="wb-mob-link wb-mob-sub" href="maintenance.html"><i class="fas fa-sync-alt"></i> Unlimited Updates</a>
      <a class="wb-mob-link wb-mob-sub" href="seo.html"><i class="fas fa-search"></i> Local SEO</a>
      <a class="wb-mob-link wb-mob-sub" href="google-business-management.html"><i class="fab fa-google"></i> Google Business Profile</a>
      <a class="wb-mob-link wb-mob-sub" href="ai.html"><i class="fas fa-robot"></i> AI Chatbot</a>
      <a class="wb-mob-link wb-mob-sub" href="ads.html"><i class="fas fa-ad"></i> Ad Management</a>
      <a class="wb-mob-link wb-mob-sub" href="one-time-project.html"><i class="fas fa-hammer"></i> One-Time Projects</a>
      <hr class="wb-mob-divider">
      <a class="wb-mob-link" href="pricing.html">Pricing</a>
      <a class="wb-mob-link" href="faq.html">FAQ</a>
      <a class="wb-mob-link" href="blog.html">Blog</a>
      <a class="wb-mob-link" href="help.html">Help</a>
      <a class="wb-mob-link" href="contact-us.html">Contact</a>
      <hr class="wb-mob-divider">
      <a class="wb-mob-cta" href="client-start.html"><i class="fas fa-user"></i> Client Portal</a>
    </div>
  </div>
</header>
<div class="wb-header-spacer"></div>"""

# Blog posts: same but all internal hrefs get ../ prefix
BLOG_NAV = ROOT_NAV.replace('href="index.html"', 'href="../index.html"') \
                   .replace('href="services.html"', 'href="../services.html"') \
                   .replace('href="manage.html"', 'href="../manage.html"') \
                   .replace('href="maintenance.html"', 'href="../maintenance.html"') \
                   .replace('href="seo.html"', 'href="../seo.html"') \
                   .replace('href="google-business-management.html"', 'href="../google-business-management.html"') \
                   .replace('href="ai.html"', 'href="../ai.html"') \
                   .replace('href="ads.html"', 'href="../ads.html"') \
                   .replace('href="one-time-project.html"', 'href="../one-time-project.html"') \
                   .replace('href="pricing.html"', 'href="../pricing.html"') \
                   .replace('href="faq.html"', 'href="../faq.html"') \
                   .replace('href="blog.html"', 'href="../blog.html"') \
                   .replace('href="help.html"', 'href="../help.html"') \
                   .replace('href="contact-us.html"', 'href="../contact-us.html"') \
                   .replace('href="client-start.html"', 'href="../client-start.html"') \
                   .replace('src="images/', 'src="../images/')


def extract_nav_wrap(html):
    """Return (start_idx, end_idx) of the nav-wrap div block, or None."""
    # Handle all variants of the nav-wrap opening tag
    for marker in ('<div class="nav-wrap" id="top">', '<div class="nav-wrap" id="navWrap">', '<div class="nav-wrap">'):
        start = html.find(marker)
        if start != -1:
            break
    else:
        return None
    depth = 0
    i = start
    while i < len(html):
        if html[i:i+4] == '<div':
            depth += 1
            i += 4
        elif html[i:i+6] == '</div>':
            depth -= 1
            i += 6
            if depth == 0:
                return (start, i)
        else:
            i += 1
    return None


def process_file(path, nav_html, css_href, js_src):
    with open(path, 'r', encoding='utf-8') as f:
        html = f.read()

    # Skip if already converted
    if 'wb-header' in html:
        print(f'  SKIP (already converted): {os.path.basename(path)}')
        return

    # Replace nav-wrap block
    bounds = extract_nav_wrap(html)
    if bounds is None:
        print(f'  SKIP (no nav-wrap): {os.path.basename(path)}')
        return

    start, end = bounds
    # Trim trailing whitespace/newlines that are part of the block
    html = html[:start] + nav_html + html[end:]

    # Add CSS link before <link rel="shortcut icon" if not already present
    if css_href not in html:
        html = html.replace(
            '<link rel="shortcut icon"',
            f'<link rel="stylesheet" href="{css_href}">\n<link rel="shortcut icon"',
            1
        )

    # Add nav.js before </body> if not already present
    if js_src not in html:
        html = html.replace('</body>', f'<script src="{js_src}" defer></script>\n</body>', 1)

    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'  OK: {os.path.basename(path)}')


# ── Root pages ────────────────────────────────────────────────────────────────
print('Processing root pages...')
root_pages = glob.glob(os.path.join(ROOT, '*.html'))
for p in sorted(root_pages):
    process_file(p, ROOT_NAV, 'css/nav.css', 'js/nav.js')

# ── Blog post pages ───────────────────────────────────────────────────────────
print('\nProcessing blog pages...')
blog_pages = glob.glob(os.path.join(ROOT, 'blog', '*.html'))
for p in sorted(blog_pages):
    process_file(p, BLOG_NAV, '../css/nav.css', '../js/nav.js')

print('\nDone.')
