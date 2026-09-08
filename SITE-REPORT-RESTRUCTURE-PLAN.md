# Merged edit plan — `#view-report` restructure

Everything below was re-verified against the live files today. Where a spec's line number or claim was wrong, I say so. **Every anchor string I cite was checked with `grep -cF` and returns exactly 1.**

Ground truth established:
- `portal/index.html` is **14,533 lines**; the single inline `<script>` is **4152–14529** (`<script>` on 4151, `</script>` on 14530). Baseline check: `sed -n '4152,14529p' portal/index.html > /tmp/x.js && node --check /tmp/x.js` → **passes today**. (The dependency-map spec's `4152,14527p` truncates two lines. Use 14529.)
- `#view-report` = 3136–3412. `#rating-block` closes at **3235**, not 3238 (dependency-map's currentState is wrong here — 3236 closes `#growth-card`, 3237 closes `.dash-top`). This is the exact block one slice cuts, so it matters.
- `.dash-top` = **1482**, `.dash-top.dash-top-solo` = **1413** (reviews-split had these swapped).
- `hasCardData` = **8808**, `gc.style.display` = **8809**.
- `.rp-topbar .rp-actions` = **1480/1481** (dependency-map said 1545/1546 — those lines are `.li-sig-meta` comments).

---

## 0. What I dropped, and why

Do not carry any of this forward. Each was shown false or actively harmful by a verifier and I re-checked the ones that mattered.

| Dropped | Why |
|---|---|
| **reorder edits 11–14: move "Email me" into `#report-card`** | Two independent high-severity breaks. (a) `emailGrowthReport` (10032) itself calls `startRefreshProgress()` (10034 → `.refreshing` at 9994), and rule 1497 already dims `#report-card` — so the button would go 50% transparent and `pointer-events:none` *while displaying its own "Sending..." spinner*, for the full ~20s call. (b) Edits 13 and 14 contradict each other: 13 restyles `.growth-email-btn` globally to a ghost button, 14 reparents that same button back into the topbar next to a solid `.su-btn` pill for every client whose AI report failed. Plus a `const eb` collision with `el('report-eyebrow')` at 8844 that would be a `SyntaxError` taking the *entire* 10k-line inline script down. Payoff is cosmetic. **Leave Email me in the topbar.** |
| **reorder edit 17: child-selector dim rule** `#view-report.refreshing > *:not(...)` | Newly kills the client's only outbound link to their own site (`#site-card`, 3172) for ~20s during every refresh, and re-creates break (a) above. Replaced by an explicit id list (see Batch 1/2). |
| **reorder edit 5's fallback branch** ("if the merge doesn't land, de-indent `#keywords-card` too") | Destroys the desktop two-column search layout. `.dash-search.split { 1.5fr 1fr }` (1498) is set by `ds.classList.toggle('split', ...)` at 9015 for exactly the Growth clients who have both cards. **Unwrapping `#dash-search` is now contingent on the keywords merge, not optional.** |
| **reorder edit 18(d): "Do NOT touch line 1502 — that rule supplies the phone spacing"** | **False.** I verified 1502 (`.rp-report, #view-report > .rp-panel { margin-bottom: 20px }`, inside `@media(max-width:820px)`) is **entirely dead**: `.rp-report` loses to 1797 (same specificity, later source), and `#view-report > .rp-panel` loses to 1519 (same specificity, later source). See §Spacing below — the unwrap is *not* spacing-neutral on phones. |
| **reviews-split edit 9's `innerHTML` "tap Refresh" message** | Self-defeating. It destroys `#review-grow-panel` / `#review-link` / `#review-qr`; when the client taps Refresh, `renderGrowthMetrics` re-runs with no page reload (10023), arm 1 at 8930 finds `el('review-link')` → null, skips (null-guarded at 8932/8934), sets `rg.style.display='block'` — and the box still says "tap Refresh". Forever. Replaced with a toggled element in Batch 6. |
| **reviews-split: un-nesting `#review-grow` out of `#rating-block`** | The card's only heading (`panel-k` "Google reviews") lives *inside* `#rating-block`. I verified `growth-report/index.ts:271` — `if (byId && (byId.rating != null \|\| byId.count != null)) return byId;` — so a Google listing with **zero reviews** returns `{rating: null, count: 0, placeId}`, which is the normal payload for any business we just set up. Un-nesting gives them a titleless card containing only a QR code and a URL. **Keep it nested for this ship.** |
| **dependency-map edit #1's `hasSpeedData` HIGH finding** (omits `bestPractices`/`cwv`) | Not a high finding; not reachable. `metrics.speed` is `sp ? {...} : (old.speed ?? null)` (725–729) — `sp` truthy always yields a truthy speed object, and every other score key is lifted off that same `sp`. So `m.bestPractices` truthy ⟹ `m.speed` truthy, inductively through the `?? old.X` chain. I include the terms anyway because they cost nothing, but as belt-and-braces, **not** as a fix. Same reasoning kills reviews-split edit 8's "the old list under-counted" claim. |
| **dependency-map edit #3: "the braces are the only thing keeping this legal"** | Line 8920's `{ const rc = m.reviews.count \|\| 0; ... }` already sits inside `if (rblock)` (8915) and `if (m.reviews && ...)` (8916). The braces are incidental. Nothing in Batch 1 touches this line — just don't hoist it to function scope. |
| **dependency-map edit #7: `.rp-strip-toggle` → id lookup** | Speculative. `.rp-strip-toggle` has exactly 6 occurrences: CSS 1407–1410, markup 3177, JS 6876. One element. No slice creates a second. |
| **dependency-map risk: "syncSiteDetailsToggle can force-hide `#site-details` after the client opened it"** | Does not reproduce. 6880 force-hides only when `has` is false, and the async callers (`hdReveal`, `detectHostingDomain`, `loadSiteHealth`) only ever *reveal* rows. |
| **keywords-merge edit 11: removing `min-width: 56px` from `.kw-move`** | Visible pill-size churn for ~11px. The wrap fix on `.kw-q` (1841) is what actually stops the clipping. Keep the floor, add `flex-shrink: 0`. |
| **keywords-merge's "reRenderReportTabs blanks `#sv-tabs` on every leads load"** | A no-op — in that state the element is already empty. The guard change is still needed, for a different reason (see 2.6). |
| **dependency-map's dead-CSS inventory line numbers** | Several point at *live* rules. `.rp-stat .val/.lab/.sub` is 1472–1474 (not 1481–1483 — those are `.rp-topbar .rp-actions`, `.dash-top` and `.dash-search`). `.rp-two` is 1475 (not 1494 — that's `.rpg-pct`). **Do not delete dead CSS by those numbers.** |
| **missing-sources: all client-facing copy** | Deferred, not deleted — see Batch 7 and Decision D9. Its highest-value line (search not connected) is superseded by Batch 2's in-card empty state, and its verifier found a genuine high-severity client-blaming bug (below). |

### The one high-severity break I fold in rather than drop

`missing-sources` edit 1 computes `placeOn = !!place_id && !!PLACES_KEY`. `PLACES_KEY` is a **module constant** (`growth-report/index.ts:27–28`) and `pullReviews` bails at 264 when it's unset. So if `GOOGLE_PLACES_KEY` is ever rotated or expires, *every* client resolves to `reviews: 'unset'` and — under that spec's copy — is told "Your Google business listing is not linked to this report yet. Send us a link." That is our outage, broadcast as an accusation. Batch 7 fixes it by never folding our secret into the per-client precondition.

---

## Spacing: the fact all three specs got wrong

Two specs assert the wrapper unwraps are "numerically identical" / "spacing-neutral". They are not, on phones.

- `.dash-top` gets `margin-bottom: 16px` (1482) and **20px at ≤820px** (1500 — live, same specificity, later source).
- `.dash-search` same: 16px (1483), **20px at ≤820px** (1501 — live).
- A direct child of `#view-report` matching `.rp-panel` gets `margin-bottom: 16px` from **1519** at *every* width, because 1519 beats 1502 on source order at identical specificity.

**Net: unwrapping either grid drops the phone gap from 20px to 16px.** That is acceptable and arguably a fix — it lands both cards consistent with `#suggest-card`, `#bench-card`, `#ai-tools-card` and `#season-card`, which are all already 16px. But state it as a change, not a no-op. Line 1502 is dead CSS either way.

---

## Batches

Apply serially. `portal/index.html` deploys as one static file (`wrangler pages deploy portal`); `growth-report` deploys separately. **Batches 1–6 are portal-only and ship without touching the server. Batch 7 is server-only and ships without touching the portal.**

Before anything:

```
cp portal/index.html /tmp/index.html.bak          # portal/ is gitignored, no diff to fall back on
sed -n '4152,14529p' portal/index.html > /tmp/base.js && node --check /tmp/base.js
```

---

### Batch 1 — Split reviews into `#reviews-card` *(portal, markup + CSS + JS)*

Cut `#rating-block` out of `#growth-card` and give it its own card. `#review-grow` **stays nested inside `#rating-block`** (see §0).

**1.1 — Markup: remove the reviews subtree from `#growth-card`.** Replace lines **3207–3236** (the 10-space `</div>` closing `.gc-cols`, through the 8-space `</div>` closing `#growth-card`) with just those two survivors:

```
          </div>
        </div>
```

Old string starts `          </div>\n          <!-- Google reviews: full width below the scorecard` and ends with the 8-space `        </div>`. **Do 1.1 before 1.2** — if 1.2 lands first there are momentarily two `id="rating-block"` elements and `el('rating-block')` silently picks the first.

**1.2 — Markup: insert the new card.** Immediately **before** the line `      <!-- Search visibility + keyword rankings, side by side on desktop (grid gets .split when both show) -->` (3239), with one blank line after. 6-space indent for the card. Copy the five `★` characters verbatim from 3214.

```html
      <!-- Google reviews: its own card. Rating + Review Radar + the review-collection link and QR.
           Split out of #growth-card, which is site speed and accessibility only. -->
      <div class="card rp-panel" id="reviews-card" style="display:none;">
        <div id="rating-block" style="display:none;">
          <div class="panel-k">Google reviews</div>
          <div class="rating-row">
            <div class="rating-big" id="rating-score">--</div>
            <div><div class="stars" id="rating-stars">★★★★★</div><div class="rating-sub" id="rating-count"></div></div>
          </div>
          <!-- Review Radar: surfaces the latest review with a drafted reply + one-tap actions -->
          <div id="review-radar" style="display:none;margin-top:14px;"></div>
          <!-- Review growth: a shareable link + QR to collect more Google reviews -->
          <div id="review-grow" style="display:none;margin-top:14px;">
            <button type="button" class="rev-grow-toggle" onclick="toggleReviewGrow()"><i class="fa-solid fa-star"></i> Get more reviews</button>
            <div id="review-grow-panel" style="display:none;">
              <div class="rev-grow-sub">Hand this to a happy customer, or text it after a job. It drops them straight onto your Google review form.</div>
              <div class="rev-grow-row">
                <img id="review-qr" alt="Scan to leave a review" width="120" height="120" />
                <div style="min-width:0;flex:1;">
                  <div class="rev-grow-link" id="review-link">--</div>
                  <button type="button" class="rev-copy-btn" onclick="copyReviewLink()"><i class="fa-regular fa-copy"></i> Copy link</button>
                </div>
              </div>
            </div>
          </div>
          <!-- "Draft a reply to a review" moved to Business tools: it is the same shape as every
               other helper there (paste something, get text back, copy it) and having it live here
               alone was the odd one out. Review Radar still opens it via reviewReplyFromRadar(). -->
        </div>
      </div>
```

The leading `<div class="rp-divide"></div>` (old 3210) is **deliberately dropped** — it was a mid-card separator and is a hairline against nothing at the top of a card. Keep the `.rp-divide` CSS rule (1521): two JS generators at 9867 and 9888 still emit it.

**1.3 — Comment at 3197.** Replace `        <!-- Metrics: site speed + Google reviews (full width) -->` with:
```
        <!-- Scorecard: site speed + accessibility. Reviews moved to #reviews-card below. -->
```

**1.4 — Comment at 1416.** Replace `       speed on the left, accessibility (+ reviews) on the right. */` with:
```
       speed on the left, accessibility on the right. */
```

**1.5 — CSS 1497, add the new card to the dim list.** Replace with:
```css
    #view-report.refreshing #report-card, #view-report.refreshing #growth-card, #view-report.refreshing #reviews-card, #view-report.refreshing #dash-search { opacity: .5; transition: opacity .2s ease; pointer-events: none; }
```
**Batch 2 edits this line again** (swaps `#dash-search` for `#search-graph-card`). Anchor on this batch-1 result, not on the original.

**1.6 — JS: split the gate.** Replace 8804–8808 (four comment lines + the `hasCardData` line) with:
```js
  // Nothing measured yet is not the same as a site we could not measure. Showing this card empty
  // opened a brand-new client's first report with "your website blocks automated tests". Reviews
  // moved to #reviews-card, so this gate is PageSpeed-only again. The extra score keys all come off
  // the same PageSpeed run as m.speed, so they are belt-and-braces rather than new coverage.
  const hasCardData = !!(m.speed || m.accessibility || m.seo || m.bestPractices || m.cwv);
```
Keep the name `hasCardData` (line 8809 unchanged; Batch 7's eventual renderer reads it).

**1.7 — JS: the new card's gate.** Insert after the `  }` that closes `if (rg)` at 8948, before the blank line and the `// Search visibility.` comment. 2-space indent:
```js
  // Reviews card visibility is DERIVED from #rating-block rather than re-tested from the data, so
  // the two can never drift. It MUST be visible whenever #rating-block is, or the home hero's rating
  // tile hits goToReportSection's `t.offsetParent === null` bail (4594) and dumps the client at the
  // top of the report. 'flex', not 'block': .rp-panel is display:flex; flex-direction:column (1517).
  const revCard = el('reviews-card');
  if (revCard) revCard.style.display = (rblock && rblock.style.display !== 'none') ? 'flex' : 'none';
```
`rblock` is declared at 8914 at function-body scope. `revCard` has zero prior occurrences.

**Check after Batch 1**
- `node --check` on the extracted script.
- `command grep -c "reviews-card" portal/index.html` → **4** (1497, markup, JS gate ×2).
- `command grep -n "rating-block" portal/index.html` → 3 hits: markup, 8914, 9264.
- Growth client with a rating: two cards, speed/accessibility then Google reviews. No stray hairline at the top of the reviews card.
- Home dashboard → tap the **Google rating tile** → it must scroll to and flash the reviews card. This is the single most likely thing to break in this batch.
- A client with a rating but no PageSpeed run must now show **only** the reviews card, no empty "We haven't measured your site speed yet" card.

---

### Batch 2 — Merge `#keywords-card` into `#search-graph-card`, delete `.dash-search` *(portal, markup + CSS + JS)*

The biggest JS change. **2.8 and 2.9 must land together** — 2.8 deletes the `kwCard` binding that 2.9's block reads at 9013, so 2.8 alone is a `ReferenceError` that aborts the rest of `renderGrowthMetrics`.

**2.1 — Markup.** Replace **3239–3258** (the comment through the `</div>` closing `.dash-search`) with:

```html
      <!-- How Google is treating you: search visibility and the keyword rankings behind it, one card.
           These were two cards, two headings and two sets of padding telling one story. -->
      <div class="card rp-panel graph-panel" id="search-graph-card" style="display:none;">
        <div class="panel-k" id="sv-period">In the last 2 months</div>
        <div id="sv-body" style="display:none;">
          <div class="hh-gtabs sv-tabs" id="sv-tabs" style="margin:14px 0 14px;"></div>
          <div class="graph-top">
            <div><div class="chart-big" id="sv-total">--</div><div class="chart-sub" id="sv-sub"></div></div>
            <span class="delta" id="sv-delta" style="display:none;"></span>
          </div>
          <div id="sv-chart" class="sv-chart"></div>
        </div>
        <!-- Shown in place of the chart when no Search Console data reached us. -->
        <div class="sv-empty" id="sv-empty" style="display:none;"></div>
        <div class="rp-divide" id="sv-divide" style="display:none;"></div>
        <!-- Keyword rankings, folded in below the hairline. Real for Growth/Elite, locked for Essential. -->
        <div id="kw-body" style="display:none;">
          <div class="panel-k">Ranking on Google</div>
          <div class="kw-sub" id="kw-sub">The searches bringing people to you, and how your position has moved.</div>
          <div id="keywords-list" class="kw-list"></div>
        </div>
      </div>
```

Three things are load-bearing here: keep `graph-panel` on the card (`.graph-panel .graph-top`, 1777, is `.graph-panel`'s only rule and `.graph-top` is otherwise unstyled); keep `hh-gtabs` on the tabs div (`.sv-tabs` has **no CSS rule anywhere** — all styling is `.hh-gtabs` 508 / `.hh-gtab` 509–511); and `#sv-body` starts `display:none` so 2.5's guard is honest from first paint. `#sv-foot` is gone.

**2.2 — CSS deletions.** Delete **1483** (`.dash-search { display: grid; ... }`), **1498** (`@media(min-width:821px) { .dash-search.split ... }`), **1501** (the ≤820px `.dash-search`), **1793–1794** (`.chart-foot` and `.chart-foot b` — both exist only for `#sv-foot`). Leave 1486 alone for now; Batch 3 kills it once `.dash-top` is gone too.

**2.3 — CSS 1497 again.** Replace `#dash-search` with `#search-graph-card` in the batch-1 result:
```css
    #view-report.refreshing #report-card, #view-report.refreshing #growth-card, #view-report.refreshing #reviews-card, #view-report.refreshing #search-graph-card { opacity: .5; transition: opacity .2s ease; pointer-events: none; }
```
Naming the merged card covers the keywords half, which `#dash-search` used to cover as a wrapper. `#site-strip` is deliberately **not** in this list — its outbound site link stays live during a refresh.

**2.4 — CSS insert, after 1488 (`.sv-chart svg { max-width: 100%; }`).** This is the one silent visual regression in the whole plan if you skip it:
```css
    /* Merged search card. #sv-body reproduces the flex-column parent #sv-tabs had as a direct child
       of .rp-panel; in a plain block it stays inline-flex, shrinks to content and jumps left. */
    #sv-body { display: flex; flex-direction: column; min-width: 0; }
    .sv-empty { font-size: 13px; color: #3c4160; line-height: 1.6; margin-top: 12px; max-width: 62ch; }
    .sv-empty .a11y-btn { margin-top: 12px; }
```

**2.5 — CSS `.kw-q` wrap fix (1841).** The keywords column is currently ~220px on desktop and ~198px on a 390px phone, and `.kw-q` is the only `flex:1; min-width:0` item in `.kw-row`, so it absorbs every pixel of shortfall — a real search phrase truncates to protect a grey "no change" pill. Replace 1841 with:
```css
    .kw-q { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; color: var(--text); line-height: 1.4; overflow-wrap: anywhere; }
```
`anywhere` (not `break-word`) is correct: it reduces the min-content contribution, which is what makes it safe next to `flex:1; min-width:0`. Then add `flex-shrink: 0;` to **1842** (`.kw-pos`) and **1844** (`.kw-move`) — once `.kw-q` can wrap it is no longer the only shrinkable item. **Keep `min-width: 56px` on `.kw-move`.**

Do not rename or scope `.kw-sub`: it is shared with `#bench-sub` at markup 3273, written by the benchmark block at 8999/9003.

**2.6 — JS: shared helpers.** Insert immediately **before** `function reRenderReportTabs() {` (7872), column 0:
```js
// One expression, two callers: renderGrowthMetrics builds the tab row on load, reRenderReportTabs
// rebuilds it when the leads series lands. They were byte-identical copies (7876 and 8959) that had
// to be edited in lockstep, which is exactly the pair that drifts.
function reportTabsHtml(mets) {
  if (!mets || mets.length < 2) return '';
  return mets.map(x => '<button type="button" class="hh-gtab' + (x.key === (window._reportMetric || 'impressions') ? ' on' : '') + '" data-field="' + x.key + '" onclick="reportSwitchMetric(\'' + x.key + '\')">' + x.tab + '</button>').join('');
}
// The heading has to name the period of the metric actually on screen. "In the last 2 months" is true
// of the Search Console series (growth-report:485 pulls a 60-day window and stores startDate/endDate
// at :509) and false of Leads, whose series is at most 30 days and gets trimmed shorter (9614-9615).
function reportPeriodLabel(mtr) {
  if (mtr && mtr.src === 'leads') {
    const n = (reportSeriesFor(mtr) || []).length;
    return n >= 2 ? 'In the last ' + n + ' days' : 'Leads so far';
  }
  const s = window._reportSearch;
  if (s && s.startDate && s.endDate) {
    const d = Math.round((new Date(s.endDate + 'T00:00:00') - new Date(s.startDate + 'T00:00:00')) / 86400000);
    if (d >= 55) return 'In the last 2 months';
    if (d >= 25) return 'In the last month';
    if (d >= 2) return 'In the last ' + d + ' days';
  }
  return 'In the last 2 months';
}
```
Copy the `\'` escaping in `reportTabsHtml` **verbatim from line 7876** rather than retyping it.

**2.7 — JS: `reRenderReportTabs`.** Replace **all of 7872–7877** (the whole function — the keywords-merge spec anchored on line 7873 alone while instructing a 4-line replace; done literally that leaves line 7874 referencing a `card` binding that no longer exists, which is a runtime `ReferenceError` `node --check` cannot catch):
```js
function reRenderReportTabs() {
  const tb = el('sv-tabs'), body = el('sv-body');
  // Gate on the chart body, not the card: the card is now also visible when there is no Search
  // Console data at all, with an explanation in place of the chart, and that state has no tabs.
  if (!tb || !body || body.style.display === 'none') return;
  tb.innerHTML = reportTabsHtml(reportAvailableMetrics());
}
```

**2.8 — JS: period heading follows the tab.** Insert one line immediately after `  window._reportMetric = mtr.key;` (7882) inside `reportDrawMetric`:
```js
  const per = el('sv-period'); if (per && metricUnlocked(mtr.key)) per.textContent = reportPeriodLabel(mtr);
```
The `metricUnlocked` guard matters: without it, an Essential client tapping the locked Leads tab retitles the card to describe data they are being told they cannot see, next to the deliberately blanked total at 7890.

**2.9 — JS: search block.** Replace **8950–8971** (the two comment lines through the `}` closing `if (card)`):
```js
  // Search visibility + keyword rankings, one card. Both plans see the headline numbers; the trend
  // CHART, the up% delta and the ranking list are Growth-only.
  const card = el('search-graph-card');
  const s = m.search;
  window._reportSearch = s || null;   // Year in Review (12614) reads _reportSearch.monthly. This line
                                      // must stay OUTSIDE every card guard, exactly where it is.
  const hasSearch = !!(s && (s.impressions != null || s.clicks != null));
  const svBody = el('sv-body'), svEmpty = el('sv-empty');
  if (card) {
    if (hasSearch) {
      if (svBody) svBody.style.display = '';   // '' not 'block', so the stylesheet's flex wins
      if (svEmpty) { svEmpty.style.display = 'none'; svEmpty.innerHTML = ''; }
      const mets = reportAvailableMetrics();
      const tb = el('sv-tabs');
      if (tb) tb.innerHTML = reportTabsHtml(mets);
      if (!window._reportMetric || !mets.find(x => x.key === window._reportMetric)) window._reportMetric = (mets[0] && mets[0].key) || 'impressions';
      reportDrawMetric(window._reportMetric, false);   // also writes the period heading
    } else {
      // No Search Console data reached us. Hiding the card took the chart, the ranking list and the
      // average position off a paying client's report in one go with nothing saying why. Say nothing
      // about the CAUSE: search is null for four separate reasons (getGscAccessToken returned null,
      // the site_url is unusable, no property matched, or the API errored) and most of them are ours,
      // so naming one would accuse the client of our own outage.
      if (svBody) svBody.style.display = 'none';
      const per = el('sv-period'); if (per) per.textContent = 'How Google sees you';
      if (svEmpty) {
        svEmpty.innerHTML = 'We cannot read Google Search Console data for your site right now, so there is no search chart or ranking list here. '
          + '<button type="button" class="a11y-btn" id="sv-empty-cta">Ask us to check it</button>';
        svEmpty.style.display = 'block';
        const cta = el('sv-empty-cta');
        if (cta) cta.onclick = () => goToRequestForm({ type: 'SEO or metadata', notes: 'Please check my site\'s Google Search Console connection so my report can show search data.' });
      }
    }
    // Mirrors #growth-card's tightened gate: the card earns its place once the report has anything in
    // it, but a brand-new client's first, empty report must not open with "we cannot see Search
    // Console". Bare m.reviews is truthy with a null rating (growth-report:189), hence the rating test.
    card.style.display = (hasSearch || m.speed || (m.reviews && m.reviews.rating != null) || rep) ? 'flex' : 'none';
  }
```
Attaching the CTA handler in JS rather than as an inline `onclick` removes the plan's worst escaping hazard (escaped single quotes inside a JS string inside an HTML attribute inside an inline `<script>`).

**2.10 — JS: keywords block.** Replace **8973–8992** (the comment through the `}` closing `if (kwCard)`):
```js
  // Keyword rankings, now the lower half of the same card. Average position lives in this sub-line
  // because it is the one number the whole list is about and it has no tab of its own. Click-through
  // rate DOES have one (the Click rate tab prints the same figure with the same label, 7869/7890), so
  // #sv-foot was repeating a tab and is gone. The adv gate that footer defended is kept.
  const kwBody = el('kw-body'), kwSub = el('kw-sub'), kwDiv = el('sv-divide');
  if (kwBody) {
    const kws = (adv && s && Array.isArray(s.topQueries)) ? s.topQueries.filter(k => k && k.position != null) : [];
    let subTxt = '';
    if (adv && kws.length) {
      subTxt = 'The searches bringing people to you, and how your position has moved.'
        + (s.position != null ? ' Across all of them you sit at position ' + s.position + ' on average.' : '');
      el('keywords-list').innerHTML = kws.slice(0, 6).map(k => {
        let move;
        if (k.change == null) move = '<span class="kw-move new">new</span>';
        else if (k.change >= 0.5) move = '<span class="kw-move up"><i class="fa-solid fa-arrow-up"></i> ' + Math.round(k.change) + '</span>';
        else if (k.change <= -0.5) move = '<span class="kw-move down"><i class="fa-solid fa-arrow-down"></i> ' + Math.abs(Math.round(k.change)) + '</span>';
        else move = '<span class="kw-move flat">no change</span>';
        return '<div class="kw-row"><span class="kw-q">' + he(k.query) + '</span>' + move + '<span class="kw-pos"><small>#</small>' + Math.round(k.position) + '</span></div>';
      }).join('');
      kwBody.style.display = 'block';
    } else if (adv && hasSearch) {
      // Connected, but Google has not reported a ranked query yet (a young or very quiet site).
      // Without this arm the lower half emptied silently and took the average position with it.
      subTxt = 'Google has not reported a ranked search for your site yet.'
        + (s.position != null ? ' Your average position across everything you show up for is ' + s.position + '.' : '')
        + ' The list fills in as people start finding you through search.';
      el('keywords-list').innerHTML = '';
      kwBody.style.display = 'block';
    } else if (!adv && (m.speed || m.reviews || s || rep)) {
      // Essential: a blurred sample of the ranking list they can unlock with Growth.
      el('keywords-list').innerHTML = lockedPreview(sampleKeywordRows(), 'See where you rank on Google', 'The exact searches bringing people to you, and how your position moves.');
      kwBody.style.display = 'block';
    } else { kwBody.style.display = 'none'; }
    if (kwSub) { kwSub.textContent = subTxt; kwSub.style.display = subTxt ? '' : 'none'; }
    if (kwDiv) kwDiv.style.display = (kwBody.style.display !== 'none') ? '' : 'none';
  }
```

**2.11 — JS: delete the split logic.** Delete **9009–9016** (the comment `// Search visibility + keyword rankings sit side by side only when both are present.` through the `}` closing `if (ds)`). Keep the blank line 9017 and the `}` at 9018. **Not 9008** — that's a deliberate blank line.

**Check after Batch 2**
- `node --check`. This is the batch where it earns its keep.
- `command grep -n "dash-search\|sv-foot\|chart-foot\|keywords-card\|kwCard" portal/index.html` → **zero hits**.
- `command grep -c "hh-gtabs" portal/index.html` and confirm the merged markup still carries it.
- Growth client with search data + ranked keywords: **the tab row must be right-aligned.** If it jumped to the left, 2.4 is missing.
- Tap through every tab. Views / Clicks / Click rate / Leads. The heading changes with the tab; the chart redraws; no horizontal scroll at 360px.
- Growth client with **no** GSC property: the card is present with the explanation and the CTA, not gone.
- Essential client: locked keyword preview renders under the hairline; the Click rate tab locks on tap and the heading does **not** change.

---

### Batch 3 — Reorder the report to action-first *(portal, markup moves + dead CSS)*

Pure block moves, no JS. After Batches 1–2 the top-level children of `#view-report` are, in order: topbar, `#refresh-progress`, `#report-card`, `#site-strip`, `.dash-top`(→`#growth-card`), `#reviews-card`, `#search-graph-card`, `#suggest-card`, `#bench-card`, `#ai-tools-card`, `#season-card`.

Target (each block = its leading HTML comment + the element, one blank line between):

1. topbar · 2. `#refresh-progress` · 3. `#site-strip` · 4. `#report-card` · 5. `#suggest-card` · 6. `#reviews-card` · 7. `#ai-tools-card` · 8. `#search-graph-card` · 9. `#growth-card` · 10. `#bench-card` · 11. `#season-card`

Five moves get you there:

- **3.1** Move the `#site-strip` block (comment `<!-- Slim site strip: domain + up-status inline...` through the `</div>` closing `#site-strip`) to immediately **above** the `<!-- AI report: a friendly, plain-English summary...` comment.
- **3.2** Move the `#suggest-card` block (`<!-- Growth opportunities + Timely ideas, merged into one ranked queue...`) to immediately **after** `#report-card`'s closing `</div>`.
- **3.3** Move the `#reviews-card` block (from 1.2) to immediately **after** `#suggest-card`.
- **3.4** Move the `#ai-tools-card` block (both comment lines `<!-- Business tools folded into the report. Photo captions are free on every plan; the rest are` …) to immediately **after** `#reviews-card`.
- **3.5** Unwrap `.dash-top` and relocate `#growth-card`: delete the two wrapper lines `      <div class="dash-top dash-top-solo">` and its matching `      </div>`, re-indent the `#growth-card` block by −2 spaces (**do the re-indent as its own commit-sized step**, separate from the move, or every later diff in that block is noise), then move it to sit immediately **after** `#search-graph-card` and before `#bench-card`.

**3.6 — Dead CSS.** Delete **1413** (`.dash-top.dash-top-solo`), **1482** (`.dash-top`), **1500** (the ≤820px `.dash-top`), and now **1486 plus its comment at 1484–1485** (both grids are gone, so `.dash-top > *, .dash-search > * { min-width: 0 }` matches nothing). Optionally delete **1502** — it is dead either way (see §Spacing), but leaving it will mislead the next reader.

**Check after Batch 3**
- `command grep -c "dash-top" portal/index.html` → **0**.
- `node --check` (should be unchanged — no JS in this batch; run it anyway to catch a stray paste into the script region).
- Load the report at **360px, 800px and 1200px**. Card order matches the target list. No horizontal scroll at 360px. Vertical gaps between cards are even (all 16px now).
- `#suggest-card` still renders — it is revealed by `sugCard.style.display='block'` at 8862, unconditionally.
- Tap **Refresh** and watch: `#report-card`, `#growth-card`, `#reviews-card` and `#search-graph-card` dim; the topbar, the progress bar and `#site-strip` do not.

---

### Batch 4 — Sticky refresh progress bar *(portal, 2 CSS lines — must ship together)*

**4.1** Replace **1487**:
```css
    /* clip, not hidden: `overflow-x: hidden` forces overflow-y to compute to `auto`, which makes
       #view-report its own scrollport and silently kills position:sticky on #refresh-progress.
       `clip` does not create a scroll container, so the sideways guard survives and sticky works.
       Note it also drops the block formatting context `hidden` provided, so margins can now collapse
       through #view-report's edges. Nothing here relies on that today. */
    #view-report { overflow-x: clip; }
```
**4.2** Replace **1490**:
```css
    /* Sticky under the 56px topbar while a refresh runs, so the percentage stays on screen however far
       down the report they have scrolled. z-index only has to beat the cards it slides over: .body has
       a permanent stacking context (see hoistModals, 4176-4185), so this can never cover the topbar. */
    .refresh-progress { position: sticky; top: 56px; z-index: 5; margin-bottom: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 15px 18px; box-shadow: 0 2px 12px rgba(15,18,40,.05); }
```

**4.1 without 4.2 does nothing; 4.2 without 4.1 does nothing.** `.topbar` is `height: 56px` at every breakpoint (114; the only media override at 1189 sets `overflow` only), so `top: 56px` is universal. `.section-nav` (1272–1296) is a second sticky at the same 56px with `z-index: 9`, but it is dead CSS — `class="section-nav"` appears nowhere in the markup — so there is no collision today. Do not revive it inside a detail view without revisiting this.

**Check after Batch 4** — open the report, scroll to the bottom, tap **Refresh**. The percentage bar pins just under the topbar and stays there. It never covers the topbar. When the refresh completes the bar disappears and content jumps up by ~62px — watch that on a phone and decide whether it needs a fade (Decision D7).

---

### Batch 5 — Promote "Recently handled" out of the details drawer *(portal, markup + CSS + JS)*

**5.1** Cut the `#site-health` block (comment `<!-- Proactive monitoring: only the reassuring "we handled this" side, never open problems -->` plus the `<div id="site-health" ...>` through its `</div>`) out of `#site-details` and re-insert it as a **sibling** of `.rp-strip-row` — between the `</div>` closing `.rp-strip-row` and the `<div class="rp-strip-details" id="site-details" ...>` line. Re-indent to 8 spaces. Add as the last child, after `#site-health-list`:
```html
          <button type="button" class="health-all" onclick="navigateTo('updates')">See more in Updates <i class="fa-solid fa-arrow-right"></i></button>
```
Wording note: `loadWhatsNew` (11907) is a **blended** feed — portal news, completed requests, fixed issues, reviews and lead digests, capped at 40 (11936). "See everything we have handled" overpromises; "See more in Updates" does not. It does *not* overpromise on recency: `loadWhatsNew` applies no 45-day floor to `site_issues`, so Updates genuinely shows further back than the strip.

**5.2** Replace **1424** (`.site-health { margin-top: 22px; }`):
```css
    /* Now a tail on the site strip rather than a drawer row, so it brings its own hairline. */
    .site-health { margin-top: 13px; padding-top: 13px; border-top: 1px solid var(--border); }
    .health-all { display: inline-flex; align-items: center; gap: 6px; background: none; border: none; padding: 2px 0 0; margin-top: 2px; font-family: 'Poppins', sans-serif; font-size: 12px; font-weight: 700; color: var(--brand); cursor: pointer; }
    .health-all:hover { text-decoration: underline; }
    .health-all i { font-size: 9px; }
```
Do not touch `.health-txt` / `.health-date` (1461–1462) — those are what `loadSiteHealth` actually emits at 6904–6905, and they live 35 lines away.

**5.3** Replace **6878**:
```js
  const has = ['hosting-row', 'domain-row', 'email-row', 'renewal-row'].some(shown);
```
and strike "recently-handled" from the comment at **6882**. Without this, `syncSiteDetailsToggle` keeps offering the "Site details" toggle for a drawer that now opens onto nothing but `#hosting-card` — the exact failure it was written to prevent.

**5.4** Replace **6897–6900** in `loadSiteHealth`:
```js
    // The note filter belongs in the query, not after it: .limit() applies BEFORE the client-side
    // filter, so note-less "fixed" rows (dispatch-request writes exactly those) used to swallow the
    // tail and hide older noted fixes. Keep the JS truthiness check too - `not is null` passes ''.
    const { data } = await sb.from('site_issues')
      .select('client_note, fixed_at').eq('user_id', userId).eq('status', 'fixed')
      .not('client_note', 'is', null)
      .gte('fixed_at', since).order('fixed_at', { ascending: false }).limit(2);
    const rows = (data || []).filter(r => r.client_note);
```
Cutting `.limit(4)` to `.limit(2)` **without** moving the filter server-side makes a latent bug reachable — do not apply the limit change alone. Leave the three `syncSiteDetailsToggle()` calls in `loadSiteHealth`; they're now no-ops for this row but `hdReveal`, the MX/RDAP branches and the strip reveal at 6530 still need the function.

**Check after Batch 5** — `node --check`. A client with at least one noted fix: the strip shows two "Recently handled" items under a hairline without opening anything, plus the Updates link. A client with hosting/domain rows but no fixes: the "Site details" toggle is still offered and opens onto the hosting line. A client with **neither**: the toggle is hidden entirely.

---

### Batch 6 — Two independent fixes *(portal, optional, skip freely)*

**6.1 — `fileA11yFix` has no preview guard.** Verified at 8277–8290: it is the only report-side request filer without one (`fileSeoFix` 8292, `fileSug` 8250, `fileRadarRequest` 8157 all have it). In admin preview, tapping "We can fix these" on the accessibility line writes a real `update_requests` row against the impersonated client. Insert as the first statement of `fileA11yFix`:
```js
  if (IS_PREVIEW) { toast('Preview is read-only.', 'info'); return; }
```

**6.2 — The dead third arm in the review-grow branch.** A Growth client with a rating but no `placeId` on their stored snapshot matches neither arm at 8930 nor 8943 and silently gets nothing, while an Essential client with identical data gets the blurred upsell. Low frequency (pre-placeId snapshots only) and it never self-heals. Fix it **without** `innerHTML`:

Add to the Batch 1 markup as the first child of `#review-grow`, before `#review-grow-panel`:
```html
            <div class="rev-grow-sub" id="review-grow-msg" style="display:none;margin:0;"></div>
```
Insert before `    } else { rg.style.display = 'none'; }` (8947):
```js
    } else if (adv && m.reviews && m.reviews.rating != null) {
      // Growth, rating present, no Place ID on this snapshot: it predates us storing one. Toggle a
      // message rather than replacing rg.innerHTML - that would delete the very elements the Refresh
      // this message asks for would refill, and the box would keep saying "tap Refresh" forever.
      const msg = el('review-grow-msg'), pnl = el('review-grow-panel');
      if (msg) { msg.textContent = 'We need one more refresh to build your review link. Tap Refresh at the top of this page. If it is still missing after that, message us and we will reconnect your Google listing.'; msg.style.display = 'block'; }
      if (pnl) pnl.style.display = 'none';
      rg.style.display = 'block';
```
and inside arm 1, immediately before `      rg.style.display = 'block';` (8942):
```js
      { const msg = el('review-grow-msg'); if (msg) msg.style.display = 'none'; }
```

**Check** — `node --check`. Admin preview → tap "We can fix these" → toast, no row written.

---

### Batch 7 — Persist `metrics.sources` *(server only, deploys separately)*

Data collection only. **No client-facing rendering.** Ship this, let one refresh cycle run, then look at the real data before deciding what to say (Decision D9).

Insert immediately **before** `  // Review Radar: how many reviews are new since the last snapshot (0 on the first-ever pull).` (739), i.e. directly after the `};` closing the metrics literal at 738:

```ts
  // Which sources actually produced something, stored ALONGSIDE the numbers so BOTH call paths keep
  // it: the monthly cron (952, which passes no diag) and the on-demand Refresh (982). `diag` above
  // only ever fed a toast that vanished in four seconds. This must live below line 713 because `old`
  // is what separates "never worked" from "failed today", and above 780 so it is stored.
  //   ok / stale / missing / unset. "stored" means "the portal would actually render it".
  // OUR OWN secrets are never folded into a per-client precondition: PLACES_KEY is a module constant
  // (line 27), so if it is ever rotated or expires, every client at once would resolve to 'unset' and
  // any copy keyed off that would tell all of them their listing is not linked. That is our outage.
  const sp2: any = metrics.speed, rv2: any = metrics.reviews, se2: any = metrics.search;
  const cb2: any = metrics.competitors, pg2: any = metrics.pages;
  const placeSet = !!String(c.google_place_id || '').trim();
  const gscOn = !!(Deno.env.get('GSC_SERVICE_ACCOUNT') ?? '');   // read inline: not a module constant
  const srcState = (fresh: boolean, stored: boolean, configured: boolean) =>
    fresh ? 'ok' : stored ? 'stale' : configured ? 'missing' : 'unset';
  metrics.sources = {
    site: url ? 'ok' : 'unset',
    speed: srcState(!!(speed && (speed.mobile || speed.desktop)), !!(sp2 && (sp2.mobile || sp2.desktop)), !!url && !!PSI_KEY),
    reviews: !PLACES_KEY ? 'blocked'
      : srcState(!!reviews, !!(rv2 && rv2.rating != null), placeSet),
    // pullSearch collapses "no property matched", "we were removed" and "the API errored" into the
    // same null at line 502, and getGscAccessToken returning null does the same at 477. There is no
    // per-client GSC-connected flag, so this can never distinguish our fault from theirs.
    search: srcState(!!search, !!(se2 && (se2.impressions != null || se2.clicks != null)), !!url && gscOn),
    competitors: !PLACES_KEY ? 'blocked'
      : srcState(!!competitors, !!(cb2 && cb2.self && Array.isArray(cb2.competitors) && cb2.competitors.length), placeSet),
    pages: srcState(!!pages, !!(pg2 && pg2.count != null), !!url),
  };
```

Leave the `if (diag) { ... }` block at 702–708 **exactly as it is** — it still builds `note` at 985–998, which `admin.html:5480` prints verbatim on the per-client Refresh.

Nothing serializes the whole metrics object into an AI prompt (`generateSummary` 570 hand-picks into `facts`; `generateOpportunities` 611 and `generateNudges` 651 do the same; `summaryHtml` 799 destructures by name), so the new key cannot leak into a prompt or an email.

**Check after Batch 7** — deploy, run one on-demand Refresh for a known client, and read the row: `select metrics->'sources' from client_metrics where user_id = '…'`. Confirm the cron path also writes it (trigger a single-client fan-out with `{action:'refresh', only: '<user_id>'}` — call site 952 passes no `diag`, which is the whole point of writing onto `metrics` instead).

---

## Sequencing and where the risk sits

```
Batch 1  reviews split      portal   ← do first, smallest blast radius, unblocks the reorder
Batch 2  keywords merge     portal   ← largest JS change; 2.9+2.10+2.11 are ONE unit
Batch 3  reorder            portal   ← pure markup, only safe after 1 and 2 have settled the blocks
Batch 4  sticky bar         portal   ← 2 CSS lines, independent, can go anywhere after 3
Batch 5  site-health        portal   ← independent region, can go anywhere
Batch 6  two fixes          portal   ← independent, skippable
Batch 7  metrics.sources    SERVER   ← independent of all of the above, deploys on its own
```

**Hard ordering constraints (the only ones):**
- **1.1 before 1.2** — duplicate `id="rating-block"` in between.
- **Batch 1 before Batch 3** — Batch 3 moves the `#reviews-card` block that Batch 1 creates.
- **Batch 2 before Batch 3** — Batch 3's move set assumes `#dash-search` is already gone. If Batch 2 is skipped, **do not** unwrap `#dash-search` (see §0).
- **Line 1497 is edited twice**: 1.5 adds `#reviews-card`, 2.3 swaps `#dash-search` → `#search-graph-card`. Anchor 2.3 on the batch-1 result.
- **2.10 and 2.11 together** — 2.10 removes the `kwCard` binding that 2.11's block reads at 9013.
- **4.1 and 4.2 together** — either alone is a no-op.
- **5.3 and 5.4 with 5.1** — moving `#site-health` without 5.3 leaves a toggle opening onto nothing.

**Where the risk concentrates:** Batch 2, and inside Batch 2, edits 2.7/2.9/2.10. Those three splice into or replace an existing `if/else-if` chain, and 2.7 is the one the original spec anchored incorrectly (one-line anchor, four-line replace) in a way that produces a runtime `ReferenceError` that `node --check` cannot see. Read the four lines 7872–7877 on screen before replacing them.

Second-highest risk is the pair of block re-indents in Batch 3.5 — a partial re-indent renders fine (HTML ignores it) but poisons every later diff in that block.

`node --check` on the extracted script is the **only** mechanical check available. It covers Batches 1, 2, 5 and 6. It proves nothing about any markup move or any CSS edit — those need a real browser pass.

---

## Decisions for Billy

Each of these changes what a client sees. Everything else above is either invisible or strictly a fix.

| # | The choice, in one sentence |
|---|---|
| **D1** | **Does the speed + accessibility scorecard really belong at position 9, below the search card?** The reorder's target order is action-first, but it puts the site's headline health number below the fold on every phone, and `#growth-card` is usually present while the search card is often empty. |
| **D2** | **`#season-card`: leave it dead last, or move it up beside `#ai-tools-card`?** `showSeasonCard()` (8815 → 8651) sets `display:block` unconditionally, so "Create a promo" is an always-visible action card currently sitting below everything, which contradicts the whole action-first premise. |
| **D3** | **Un-hide the review link and QR** by deleting the "Get more reviews" toggle (`.rev-grow-toggle`, 3220 + CSS 1687–1688 + `toggleReviewGrow` 8081–8083), so a Growth client's review-collection link and QR code render directly in the reviews card instead of behind a click. |
| **D4** | **Show a "we cannot read your Search Console data, ask us to check it" card** (Batch 2.9) to clients who today see nothing at all there. |
| **D5** | **Let the search card heading follow the tab** ("In the last 23 days" on Leads) instead of always claiming "In the last 2 months" (Batch 2.6/2.8) — honest, but a visibly varying string. |
| **D6** | **Promote "Recently handled for you" out of the details drawer** so it is always visible, cut from 4 items to 2, with a "See more in Updates" link (Batch 5) — or leave it behind the toggle. |
| **D7** | **Pin the refresh progress bar under the topbar** while a refresh runs (Batch 4); note that when it finishes, content jumps up ~62px unless we fade it out first. |
| **D8** | **Confirm the refresh dim list**: `#report-card`, `#growth-card`, `#reviews-card`, `#search-graph-card` dim and go inert; `#site-strip` (and therefore the client's link to their own website) stays live. |
| **D9** | **Later, after Batch 7 has run one cycle**: whether missing sources get plain-English lines on the report at all, and if so whether a client with no Google listing gets a permanent, undismissable "send us a link to your listing" note forever. |

---

## Downstream artefacts that go stale

Not edits, but they will be wrong after this ships:

- `help/site-report-and-growth-tools/index.html:114–115` — the prose says the search section shows "where you typically rank". After Batch 2 that number is Growth-only inside the keyword sub-line, so an Essential reader will hunt for something that is no longer there. `images/assets/search-performance.webp` (embedded at :115, also used by `help.html`) shows the pre-merge two-card layout; `images/assets/review-radar.webp` (`help.html:8047` and the same article at :123) shows reviews welded under the speed rings. **These are hand-edited generated pages — fix the source and do not run `build-help.js --force`.**
- `portal-screenshots/04-your-site-report.png` and `client-portal.html:505, :538` (`images/assets/view-site-report.png`) both show the old card order and the `.dash-search` side-by-side grid.

---

## Regression checklist

Run this in a browser at **360px, 800px and 1200px**. Use admin preview (`IS_PREVIEW`) to reach the three client states.

**Every state**
1. Open the report. No horizontal scroll at 360px. Card order matches the target list.
2. Vertical gaps between cards look even (all 16px now, including on a phone where two of them used to be 20px).
3. Home dashboard → tap the **Google rating tile** → it navigates to the report, scrolls to the reviews card, and flashes it. If it dumps you at the top, `#reviews-card` is not being shown (Batch 1.7).
4. Tap **Refresh**. The progress bar pins under the topbar (D7). Report, scorecard, reviews and search cards dim and are unclickable. The topbar, the progress bar and the site strip stay bright — and the site-strip link to the client's own website is still clickable throughout.
5. When Refresh finishes: everything re-renders, no card disappears, no card appears empty. Run Refresh **twice** — `renderGrowthMetrics` runs up to 3× per session and every branch must be idempotent.
6. Tap **Email me** in the topbar. It disables, shows "Sending...", stays legible (it is in the un-dimmed topbar — this is exactly why we dropped the move).
7. Open **Site details** in the strip. If a hosting/domain row resolved, it opens onto it. If nothing resolved and there are no handled fixes, the toggle is not offered at all.
8. Business tools and the seasonal promo card still open, collapse and expand on mobile (`.rp-mcol > .rp-mcol-body` max-height cap, 1713/1717, is a child combinator — both card moves are position-only and cannot disturb it).

**State A — Growth client with full data** (speed + rating + Search Console + ranked keywords)
9. Two distinct cards where there used to be one: scorecard (speed rings + accessibility), then Google reviews (rating, Review Radar, review link/QR). No stray hairline at the top of the reviews card.
10. One search card, not two. Chart on top, hairline, "Ranking on Google" below it.
11. **The tab row is right-aligned.** If it collapsed to the left, CSS edit 2.4 is missing.
12. Tap every tab: Views, Clicks, Click rate, Leads. Chart redraws each time, heading follows the tab (D5), no console errors.
13. The keyword sub-line reads "…Across all of them you sit at position N on average." — that is the average position that used to live in `#sv-foot`. Confirm the CTR line is gone and the **Click rate tab** prints the same figure it used to.
14. A long search phrase (e.g. "emergency carpet cleaning near me") **wraps** instead of truncating with an ellipsis, at 360px and at 1200px. The `#N` and the movement pill stay on one line.
15. Review Radar renders with its buttons; "Draft a thank-you" still opens Business tools and expands the card on mobile.

**State B — Essential client**
16. Scorecard present. Reviews card present if they have a rating, with the review tool showing as a **blurred locked preview** (`lockedPreview` at 8945 replaces the whole `#review-grow` subtree — confirm the card still reads correctly around it).
17. Search card: headline number + chart for **Views only**. Tapping Clicks / Click rate / Leads gives the blurred upgrade panel, the headline total blanks (7890), and the heading does **not** change (2.8's `metricUnlocked` guard).
18. Below the hairline: the blurred "See where you rank on Google" keyword preview. The sub-line above it is **hidden**, not blank — no dead gap above the blur.
19. Competitor benchmark still shows its locked preview and its sub-line is empty (`.kw-sub` is shared with `#bench-sub` — if that line lost its styling, `.kw-sub` was renamed or scoped).

**State C — client with a `site_url` but no `client_metrics` row** (the first-report case)
20. `loadGrowthMetrics` (9369) finds nothing → `renderGrowthMetrics(undefined, undefined)`. The topbar reads **"Never refreshed, tap Refresh"**.
21. **No scorecard** (`hasCardData` false), **no reviews card**, **no search card** — in particular the search card must *not* open their very first report with "we cannot read your Search Console data" (that is what the `hasSearch || m.speed || rating || rep` gate in 2.9 exists for). Business tools and the seasonal card are present, as today.
22. Tap Refresh. The progress bar runs; when it lands, whatever resolved appears. If PageSpeed resolved but Search Console did not, they get a scorecard and the search card's explanation — check that reads acceptably as a first impression.
23. Also exercise the **error** path: `renderGrowthMetrics(null, null)` from the catch at 9372. Nothing should throw, and every card should end up hidden rather than half-rendered.

**Mechanically, after every batch that touches JS (1, 2, 5, 6):**
```
sed -n '4152,14529p' portal/index.html > /tmp/x.js && node --check /tmp/x.js
command grep -n "dash-search\|dash-top\|sv-foot\|chart-foot\|keywords-card\|kwCard" portal/index.html
```
The second command must return nothing once Batches 2 and 3 are both in. A `const` collision or an unbalanced brace in this file is not a degraded card — it is a `SyntaxError` that blanks the entire portal, because there is exactly one inline `<script>` and no module boundary.