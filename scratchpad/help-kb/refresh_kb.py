#!/usr/bin/env python3
# Refresh portal/help-content.json entries from the LIVE help articles, without a full rebuild.
#   python3 scratchpad/help-kb/refresh_kb.py            dry run: lists entries whose text differs from their page
#   python3 scratchpad/help-kb/refresh_kb.py --apply    rewrites only those entries' body (b), keeps everything else
# Why not a full rebuild: a full run once dropped entries and rewrote every body. This touches only
# entries that are out of date, using an extractor calibrated to the existing format (88 of 146
# untouched entries reproduce byte for byte, 140 at >= 98%). Deploy the portal afterwards.
import json, sys, os, difflib
sys.path.insert(0, os.path.dirname(__file__))
from kbextract import extract
KB = 'portal/help-content.json'
raw = open(KB).read(); kb = json.loads(raw)
stale = []
for a in kb:
    p = f"help/{a['s']}/index.html"
    if not os.path.exists(p): continue
    new = extract(open(p).read())
    if new and new != a['b'] and difflib.SequenceMatcher(None, a['b'], new).ratio() < 0.98:
        stale.append((a, new))
print(len(stale), 'entries differ from their article:', ', '.join(a['s'] for a, _ in stale))
if '--apply' in sys.argv:
    for a, new in stale: a['b'] = new
    open(KB, 'w').write(json.dumps(kb, ensure_ascii=False, separators=(',', ':')))
    print('written; now deploy the portal')
