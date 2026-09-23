import re, html
def absurl(u):
    u = u.strip()
    if u.startswith('http'): return u
    u = re.sub(r'^(\.\./)+', '', u)
    if u.startswith('help/') or '/' in u.rstrip('/'): return 'https://webeaze.io/' + ('' if u.startswith('help/') else 'help/') + u if not u.endswith('.html') else 'https://webeaze.io/' + u
    return 'https://webeaze.io/' + u
def extract(page):
    m = re.search(r'<section class="article-body">([\s\S]*?)</section>', page)
    b = m.group(1) if m else ''
    b = re.sub(r'<(script|style)[\s\S]*?</\1>', '', b)
    b = re.sub(r'<img[^>]*>', '', b)
    # An icon standing in for words ("select [person icon] in the top right corner") has to read as
    # words for the assistant, so a labelled icon becomes its label.
    b = re.sub(r'<span[^>]*aria-label="([^"]*)"[^>]*>[\s\S]*?</span>', lambda mo: mo.group(1), b)
    def link(mo):
        href, text = mo.group(1).strip(), re.sub(r'<[^>]+>', '', mo.group(2)).strip()
        if not text: return ''
        if 'portal.webeaze.io' in href:
            h = href.split('#', 1)[1] if '#' in href else ''
            return text + (' [portal: #' + h + ']' if h else '')
        if href.startswith('#') or href.startswith('mailto:'): return text
        hm = re.match(r'^(?:\.\./)+(?:help/)?([a-z0-9-]+)/(?:index\.html)?(?:#.*)?$', href) or re.match(r'^https://webeaze\.io/help/([a-z0-9-]+)/?', href)
        if hm: return text + ' [help article: ' + hm.group(1) + ']'
        return text + ' (' + absurl(href) + ')'
    b = re.sub(r'<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>', link, b)
    b = re.sub(r'<li[^>]*>', '\n\n- ', b)
    b = re.sub(r'</?(p|h[1-6]|ul|ol|div|br|tr|table|blockquote|section)[^>]*>', '\n\n', b)
    b = re.sub(r'<[^>]+>', '', b)
    b = html.unescape(b).replace('—', ', ').replace(' ', ' ')
    b = re.sub(r'[ \t]+', ' ', b)
    b = '\n\n'.join(x.strip() for x in re.split(r'\n\s*\n', b) if x.strip())
    return b
