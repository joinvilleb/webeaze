# Site report overhaul

## The one problem

The report is ordered by where the data came from, not by what the owner can do with it, so the only three blocks with a working button (site status, "Worth doing next", the reviews/tools pair) are scattered below roughly 2,000px of measurement on a 3,200px phone page. The same source-shaped design means a block with no data deletes itself in silence, so a Growth client whose Search Console was never connected just gets a shorter page and no idea anything is missing.

---

## Recommended order

| # | Block | Notes |
|---|---|---|
| 1 | Header: Back, title, **Refresh**, relative "Updated" | "Email me" moves out of the topbar |
| 2 | `#refresh-progress` | sticky under the topbar while running |
| 3 | `#site-strip`: favicon, domain, up/down pill | detail drawer gone |
| 4 | `#site-health` + `#site-health-list` (max 2 lines) | promoted out of the drawer, rendered as a tail on the strip |
| 5 | `#report-card` (headline + 3-line clamp + "We can help") | eyebrow deleted |
| 6 | `#suggest-card` "Worth doing next" | seasonal promo folded in here |
| 7 | **new** `#reviews-card`: `#rating-block` + `#review-radar` + `#review-grow` | split out of `#growth-card` |
| 8 | `#ai-tools-card` | header renamed to say what is behind it |
| 9 | `#search-graph-card` with keywords merged in | `.rp-mcol` on phone |
| 10 | `#growth-card`: speed + accessibility only | demoted |
| 11 | `#bench-card` | stays `.rp-mcol` |

Deleted outright: `#report-nav`, `#report-explain`, `#growth-upsell`, `#secure-row`, `#renewal-row` (relocated), `#site-details` drawer, `#season-card` shell.

**Above the fold at 390x844** (about 700px of content after the 56px topbar and the header row): the site strip with the live status pill, one or two "we caught and fixed this" lines, and the AI headline plus its clamped summary, with the top edge of "Worth doing next" showing. An owner who reads nothing else learns their site is up, that we did work they did not see, and what this month looks like in one sentence.

---

## Section by section

### Header and refresh

**`#growth-actions` (3153-3157) - SHRINK.** At 390px `.rp-topbar .rp-actions { width: 100% }` (1478) puts both buttons on their own line, and the "Updated" stamp is the page's one honest freshness signal but prints no year.
- Move `#growth-email-btn` (3154) out of the topbar to a ghost button at the foot of `#report-card`.
- index.html:8775: replace `toLocaleDateString('en-US', {month:'short', day:'numeric'})` with a relative stamp ("Updated today" / "Updated 5 days ago" / full date with year past ~300 days), and render "Never refreshed, tap Refresh" instead of `''` when `refreshedAt` is null.
- `refreshGrowthReport` (9966) and `emailGrowthReport` (9982) each disable only their own button. Disable both in both, or a client can fire two concurrent PageSpeed + Claude runs.

**`#refresh-progress` - KEEP.** The only block on the page that admits the server round trip is opaque, and its `data.note` path is the only place a client is ever told a source is not set up.
- `emailGrowthReport` (9982) runs the identical `refreshClient` work and gets a spinner in a button label. Add `startRefreshProgress()` / `stopRefreshProgress()` to it.
- `.refresh-progress` (1494): add `position:sticky; top:56px; z-index:8`, since `#view-report.refreshing` dims the page to `opacity:.5` (1501) and the bar scrolls away in one flick.

**`#report-nav` (3160-3161) - CUT.** Confirmed dead by whole-file counts: `scrollToReportSection` = 1 occurrence (its own definition at 13846), `reportScrollSpy` = 2 (definition plus a `removeEventListener` for a listener that is never added), `REPORT_NAV_SECTIONS` = 2. `buildReportNav` does nothing but hide the div. The markup comment at 3160 describes the opposite of what the code does.
- Delete markup 3160-3161, CSS 1480-1484, JS 13818-13856, and the `setTimeout(buildReportNav, 40)` in `navigateTo` (13808).
- Do not touch `goToReportSection` (4613). It is live: the home hero's rating tile calls it at 9220.

### Identity and proof

**`#site-strip` (3185) - KEEP, first content block.** Best value per pixel on the page, about 72px desktop and 110px phone, and the one block that cannot render wrong.
- index.html:6559 passes the raw `client.site_url` into `detectHostingDomain`, whose first statement is `new URL(siteUrl)` (14011). A bare `bearcarpet.com` throws and returns, so every detail row vanishes while the link and favicon still work (`clientSiteHref` repairs bare domains at 8424-8433). Pass `clientSiteHref(client)`.
- `.rp-strip-domain` (1397) has no vertical padding, so the strip's only link is roughly a 23px tap target. Set `padding:10px 0`.

**`#site-status` - KEEP, fix the silence.** `loadUptime` (6765) returns with no pill when there is no row, no `last_checked`, or the check is over 30 minutes old, and nothing in this repo writes `site_checks` (the writer is an external Worker). If that Worker stops, every client silently loses the pill forever and we never find out.
- Replace the two bare returns at 6768 and 6772 with a neutral grey state. `agoLabel` is already computed at 6773 and thrown away: use it. "Monitoring starts shortly" with no row, "Last checked 4 hours ago" when stale. Green/red stays exactly as it is for fresh data.
- Add `.order('last_checked', { ascending: false })` to the `.limit(1)` query at 6766.

**`#site-health` / `#site-health-list` (3208-3212) - KEEP and PROMOTE.** This is the only place in the whole portal that proves the subscription does invisible work between requests, and it is currently the last thing inside a drawer that recollapses on every page load, under five lines of DNS.
- Move the block out of `#site-details` to render as a tail on `#site-strip`, always visible when rows exist.
- Change `.limit(4)` at 6894 to 2, add `-webkit-line-clamp:2` to `.health-txt` (1458), and append a "See everything we have handled" link to `navigateTo('updates')`. `loadWhatsNew` (11855) already reads the same `site_issues` rows with the same filter at `limit(15)`, so this becomes proof plus archive instead of the same sentence twice.
- The renderer at 6887-6905 is the cleanest code in the region. Do not touch it beyond the limit.

**`#site-details` (3198) - CUT the drawer.** The toggle at 3196 renders whenever `site_url` exists with no check that anything resolved, and `#hosting-card` (3199) carries no `display:none`, so tapping it can expand a bare 16px box. That is guaranteed for the best-documented clients: 6558 only calls `detectHostingDomain` when at least one of `host_provider` / `domain_provider` is blank, and Secure, Email and Renews are all set inside that function, so filling both admin overrides deletes three unrelated rows.
- `#hosting-row` + `#domain-row` (3201-3202): **MERGE and RELOCATE.** One span reading "Hosting and domain: Cloudflare / GoDaddy", moved to the Manage plan panel beside the Pages meter. It is an account fact, not a this-month fact, and both halves die together when an ad-blocker kills the DNS-over-HTTPS fetch.
- `#secure-row` (3203): **CUT.** It is `/^https:/i.test(siteUrl)` against the stored database string (14025). Green padlock on an expired certificate, red "Not secured" on a site that redirects to HTTPS. Delete markup 3203 and the block at 14023-14031. A wrong reassurance about security is worse than none.
- `#email-row` (3204): **KEEP, move to the nudge queue.** The `mx !== null` guard at 14034 is correct and worth preserving. But "No business email set up" is a bare negative inside a closed drawer with no button, and it false-negatives every client running on gmail.com. Render the positive naming in Manage plan; route the zero-MX case into `window._nudges` so it arrives with a working "Yes, do this for me".
- `#renewal-row` (3205): **RELOCATE.** It sits near the plan card's "Renews on" (14296, the Stripe subscription) under a near-identical label. Move to Manage plan and relabel "Domain expires".
- With those gone the drawer has nothing left. Delete 3196-3198 and 3213, plus `toggleSiteDetails` (6878).

### The story and the ask

**`#report-card` (3173-3182) - KEEP at position 5, SHRINK.** It is the only block written in the owner's language and the only substantial thing an Essential client fully receives (`generateSummary` runs unconditionally; index.ts:770-772 gates only opportunities).
- **Confirmed name bug.** `sentenceCase` (8794-8803) bails only when fewer than two capitalised words follow the first. "Bear Carpet Cleaning is growing" has exactly two, so `2 < 2` is false and it lowercases the client's own company name on line one of their report. `KEEP` (8798) protects Google, SEO, WebEaze, Facebook, Instagram, and no client name. Fix: stash `window._clientBiz = client.business_name` beside `window._clientPlan` (6503) and skip any word present in it, and raise the guard to `< 3`.
- Delete `.rp-report-eyebrow` (3174) per the no-eyebrow house rule; the header's Updated stamp carries the date.
- Null-guard `el('report-headline')` at 8804 like its two neighbours.
- `setReportSummary` (4555) unconditionally re-adds `clamped` and clears `open`, so expanding the summary and tapping Refresh collapses you back to three lines mid-read. Capture `more.classList.contains('open')` first and restore it after the rAF remeasure.

**`#report-explain` (3178-3180) - CUT, but read this first.** Three of the four lenses called the comment false. It is false about index.html, but the server half is real: `explain_report` is a fully written task in ai-assist/index.ts:325-328 and is listed in `CONTEXT_TASKS` at 209. A repo-wide grep finds no caller anywhere. So the div is dead and the edge-function branch is dead with it.
- Delete markup 3178-3180 and the `explain_report` branch in ai-assist.
- Then take the cheaper win: `generateSummary` produces and stores `searched` and `recommendations` on every refresh (growth-report/index.ts:600-601). We pay Claude for both. A grep for `.searched` in portal/index.html returns **zero**. They render only in the monthly email and only for Growth/Elite (index.ts:831-833). Render `rep.searched` as the keywords subhead (below), so the in-portal card stops being strictly thinner than the email for the same generated tokens.

**`#suggest-card` (3281-3287) - KEEP and PROMOTE to position 6.** One ask, one reason, one tap that becomes a real request. It is the only block that acts rather than describes, and it currently sits sixth.
- **The empty state is unreachable.** Line 8823 is `sugCard.style.display = (hasOpp || hasNudge) ? 'block' : 'none'` directly under a comment saying an emptied queue is worth showing. The reassuring "Nothing pressing right now" copy (8215) can only be reached after the client personally clears the queue, never when the AI returned nothing, which is the common thin-data case. Change 8823 to always show and let `renderSug()` pick the copy.
- `_sugSkips` and `_sugSent` (8196) are module-level and never reset, so the two-skip copy ("we'll bring up the next one when your report refreshes") is a promise a refresh cannot keep, and one "Yes" freezes the card on its confirmation for the rest of the session. Reset both at the top of `refreshGrowthReport` (9966) **and** `emailGrowthReport` (9982), not inside `renderGrowthMetrics`, so the reset matches the two moments the queue is actually regenerated.
- `fileSug` (8235) has no `IS_PREVIEW` guard, unlike `fileRadarRequest` (8144) and `putSeasonBanner` (8681). An admin previewing gets a red error toast instead of the read-only notice. One line.
- Dead code to remove while you are in there: `window._nudgeMonth` (8820, written and never read), `.opp-btn.done` (1896-1897, never applied), `.opp-item` / `:first-child` hairline rules (1863-1864, only one item ever renders).

**`#season-card` (3421-3431) - MERGE into the suggestion queue.** All four lenses agreed, and they are right for different reasons that stack: it pitches the same seasonal promo the nudges already pitch a few hundred pixels higher from an unrelated code path, it is second to last on a 3,200px page so almost nobody reaches it, and it has no memory (nothing ever reads back the "(from Seasonal promo)" marker, so the day after ordering a banner it invites you to order it again).
- Have `showSeasonCard` push a synthetic item into `window._nudges` whose "Yes, do this for me" calls `generateSeasonBanner` inline, then delete markup 3421-3431 and the `.season-*` CSS (1745-1765). Keep the generator and the banner preview: it is the best-looking thing in the portal and the "we take it down for you" promise is real.
- Fix two bugs during the move. **Takedown date:** `putSeasonBanner` (8690) always schedules removal at `seasonInfo().endISO`, the calendar season end, while `b.season` comes from the model, which the prompt (ai-assist:312) invites to return "Christmas" or "Black Friday". A December promo is booked for takedown on March 20 and the client is told so in plain text at 8676. Derive the date from `b.season`. **Double file:** after a successful send the button reads "On its way up" but "Try another" stays live and re-renders a fresh enabled "Put this on my site", so two taps file four rows including two conflicting takedowns.
- Preview: `putSeasonBanner` has the `IS_PREVIEW` guard, `generateSeasonBanner` (8651) does not, so "Create a promo" in preview mode fires a real billed Anthropic call. Add it.

### Reviews and tools

**`#growth-card` (3218) - SPLIT.** It welds four unrelated subjects behind one unlabelled card, roughly 953px at 390px, opening with the least interesting of them.
- Lift `#rating-block` (3229) with `#review-radar` and `#review-grow` into a new `.card.rp-panel#reviews-card` at position 7. **Keep the id `rating-block` on the moved markup**: the home hero deep-links to it (9220).
- Leave `#growth-card` as speed plus accessibility and demote it to position 10.
- **Line 8777 is `gc.style.display = 'flex'` with no data check**, and `m` defaults to `{}` at 8771. A brand-new client with a `site_url` but no `client_metrics` row opens their first report to the heading SITE SPEED and "We couldn't measure your site speed. It usually means your website blocks automated tests or timed out." That reads as a broken website when the truth is no report has run. Gate on `(m.speed || m.accessibility || m.seo)` and add a real first-run line ("We have not measured your site yet. Tap Refresh."). The comment at 9322 already claims this empty state exists; it does not.
- `.gc-cols` (1415) is a hard `1fr 1fr`, so when `#a11y-check` hides, half a full-width card is blank on desktop. Change to `repeat(auto-fit, minmax(220px, 1fr))`.

**`#speed-rings` - SHRINK.** Two 100px donuts for a number the codebase itself calls a vanity score (that is why it is kept off the home page, comment at 9195). The customers of a carpet cleaner are on phones, so the Desktop ring is the same fact twice.
- Drop the desktop push at 8837, or render mobile only under 560px as a single line ("Loads in 2.1s on a phone, 86 out of 100").
- Keep `validScore` (8834) exactly as it is. Refusing to draw a "0 out of 100" ring is the honesty standard the rest of the page should meet.
- Fix the stray trailing space before `</div>` in the failure string at 8839.

**`#a11y-check` - KEEP.** One of only three blocks on the page with a real one-tap action, at 70-90px.
- **Line 8849 is `if (a.score >= 90 || !issues.length)`.** A site scoring 62 whose failing audits did not parse is told "Accessibility: Good" and then, in the next sentence, "Your site scores 62/100. Easy to use for every visitor." The page contradicts itself inside one line. Split it: green only for `>= 90`, and a neutral third branch for a low score with no parsed issues.

**`#review-radar` - KEEP, promote with the reviews card.** Highest action per pixel anywhere on the report: a real customer's words with three one-tap responses.
- `reviewReplyFromRadar` (8129-8142) never checks the plan. For an Essential client it opens the tile, `openBizTool` swaps in `#ai-locked-panel`, and the code then still writes into the hidden `#review-reply-input` and calls `draftReviewReply` on a button inside a `display:none` panel. We spend a real ai-assist call, write the answer somewhere invisible, and show an upgrade pitch. Return after `openBizTool` when `!isAdvancedPlan()`.
- `radarTestimonial` (8153) and `radarSocial` (8157) default `(r.rating || 5)`, so a missing rating files a request describing a 5-star review we do not have. Omit the rating instead.

**`#review-grow` - KEEP, unwrap.** The QR is the one thing on this page that turns directly into money.
- Drop the "Get more reviews" toggle (3240) so link + QR + Copy render directly in the reviews card. One collapse per card is enough.
- The final `else` at 8901 hides the block entirely, so a Growth client whose rating resolved through the legacy `maps.googleapis.com` path (index.ts:187-189) but has no `placeId` gets nothing, while a cheaper Essential client in the same state at least gets the blurred upsell. Add a third branch: "We need your Google listing to build your review link", plus a request button.
- `.rev-grow-toggle` (1690) has `padding:0`, an 18px tap target. Whatever survives the unwrap needs 44px.

**`#ai-tools-card` (3300) - KEEP, promote to position 8.** Seven tools that hand back finished work are the most tangible thing the subscription gives each month, and they are ninth on the page behind a chevron labelled "Quick helpers for the day to day", which says nothing.
- Rewrite `.biz-head-sub` (3305) to name the goods: "Seven helpers: reply to an inquiry, write a quote, get a QR code for your van, and four more." Title becomes "Business tools (7)".
- Delete `@media (max-width:480px) { .biz-tools-grid { grid-template-columns: 1fr } }` (1726). Two columns at 390px roughly halves the ~950px open body.
- **The Growth gate is browser-only.** ai-assist authenticates with `auth.getUser()` and never reads `clients.plan`, so all six gated tasks are callable directly and flipping `window._clientPlan` in devtools unlocks every tile. If the lock is meant to be real, it has to be enforced server-side.
- Dead/stale: `.biz-tile-tag` (1728) matches no markup; the comment at 1723 says "Essential hides three of them" (nothing is hidden) and 8370 says "Inquiry reply + FAQ are Growth/Elite" (six are).
- `.rp-mcol.open > .rp-mcol-body` is `max-height:3000px` with `overflow:hidden` and no scrollbar (1720). Seven tiles plus a long FAQ can exceed it and clip silently. Set `max-height:none` on `transitionend`.

### The numbers

**`#search-graph-card` + `#keywords-card` - MERGE, then DEMOTE to position 9.** On a phone they are two cards, two headings and two sets of padding, about 830px, telling one story: how Google is treating you.
- Move `#keywords-card`'s contents (3274-3277) inside `#search-graph-card` below an `.rp-divide`, then delete the `.dash-search` wrapper (3260), the `.split` logic at 8965-8971 and the CSS at 1486 and 1501-1507. Add `.rp-mcol` so a phone gets a header until it is opened.
- Rename the `panel-k` at 3262. "In the last 2 months" is a period masquerading as a subject, and it is simply false over the Leads tab, whose series is at most 30 days (loadLeads 9564-9571). Move the period string into `reportDrawMetric` so it follows the active tab.
- **The worst empty state on the page.** When no Search Console property matches, `pullSearch` returns null, index.ts:735 stores `search ?? old.search ?? null`, then 8918 hides the graph, 8929 cannot fire the Essential locked preview because `!adv` is false, and 8965-8971 hides the whole grid. A Growth client paying for search visibility loses the chart, the keywords and the footer at once, and the page just looks shorter. Replace the `display:none` with one line: "Google has not shared search data for your site yet. We are working on getting it connected."
- Replace the static `.kw-sub` (3275) with `rep.searched`, falling back to the current line. It also retires a subhead that lies on a first-ever report, where every row shows the purple "new" badge because there is no prior snapshot.
- Cut `kws.slice(0, 6)` (8931) to 3 or 4 on phones. `.kw-q` (1852) is `nowrap` + ellipsis at about 218px while `.kw-move` holds a 56px `min-width`, so the actual search phrase gets clipped to protect a "no change" pill. Swap `.kw-q` to `white-space:normal; overflow-wrap:anywhere` with a 2-line clamp and drop `.kw-move`'s min-width under 560px.
- **Server bug, data destroying.** growth-report/index.ts:734 sets `search: search ?? old.search`, so when a refresh's GSC call fails, `newKw` (750) and `oldKw` (751) are the same array. `prevPos[k.query]` matches every row and `k.change = position - position = 0`, so every keyword is rewritten to a grey "no change" and the real movement history is destroyed in the stored jsonb. Wrap the movement loop at 752-758 in `if (search)`.
- `#sv-foot` (3269): **MERGE.** "Avg. position 14.3 on Google" and "2.1% click-through rate" are the two most jargon-heavy strings on a page written for a landscaper, average position is restated per keyword right below, and when the footer is emptied for Essential `.chart-foot` still contributes 14px of margin (1797). Fold position into the merged keywords section as one line, delete the div and the `fp` block at 8914-8917. Keep the `adv` gate: the comment at 8912 records that gating only the chart metrics put both facts straight back on screen.
- `#sv-total`: keep the deliberate blanking on locked metrics (7884-7885, the comment explains it correctly), but render `'--'` plus the `LOCK_COPY` line into `#sv-sub` rather than leaving both blank, so a locked tab reads as locked rather than broken. Also blank the total when `drawReportChart` falls to its under-2-points placeholder (7739): today a client can read "1,204 times shown on Google" directly above "This will fill in over the next few weeks."
- `#sv-chart`: delete the `sv-trend` line and its half of `.sv-legend` (7789, 7793). A linear regression through 60 noisy days of impressions, labelled "Where you're heading", is a claim we cannot stand behind to this audience. Keep the dashed average, which reads without a key, and hide the remaining legend under 560px. Drop the svg height to 110 on phones (272px of usable width is currently squashing 60 days at 4.5px each).
- `#sv-tabs` (3263): the tab-building expression is written out verbatim at 7871 and 8911 and must be edited in both places forever. Delete the copy at 8911 and call `reRenderReportTabs()`. Drop `orders` and `revenue` from `CLIENT_GRAPH_METRICS` (7818) or add them to `REPORT_METRICS`, since neither is defined there and both are inert. Move the inline `margin:14px 0 14px` into CSS that collapses when the strip is empty.

**`#bench-card` (3290) - DEMOTE and fix.** It stays last, collapsed.
- Change the heading (3291) from "How you compare locally". Those rivals are the three highest review counts from a popularity-ranked nearby search over a 16km radius, so they are the busiest businesses in a large area, not the nearest or most comparable. "The busiest carpet cleaners near you" is what it actually is. Put the radius in `#bench-sub`.
- Add a Growth branch at 8958 mirroring review-grow: today a Growth client with no Place ID sees nothing while an Essential client sees the blurred preview, so the paying plan shows strictly less.
- `cb.checkedAt` is stored and never rendered while index.ts:736 republishes the last snapshot on failure. Print it when it is more than a week older than `refreshedAt`.
- `benchHeadline` (8060) uses `selfCount > (c.count || 0)`, so an exact tie counts as a loss and a client level on reviews is told the rival has more.
- Attach a button to the harsh line ("Get more reviews") so the comparison leads somewhere.

**`#growth-upsell` (3434-3443) - CUT.** 100% dead: two whole-file occurrences, the markup (already `display:none`) and the unconditional hide at 8973 whose own comment says the inline locked previews replaced it.
- Delete markup 3434-3443, CSS 1824-1829, lines 8972-8973, and the unreachable `.rp-upsell` halves of the spacing selectors at 1505 and 1522. It is a direct child of `#view-report`, so nothing reflows. Bonus: it removes one of the two "UNLOCK WITH GROWTH" eyebrow kickers.

---

## Where the lenses disagreed, and my call

**1. Where the AI summary goes.** Owner wanted it demoted below the business tools; mobile and infodesign wanted it at the top; honesty put it mid-page. **My call: keep it high (position 5) but shrunk.** The owner lens is right that it changes nothing about today, but it is the only block written in the client's own language, the only substantial thing an Essential client fully receives, and once the eyebrow is gone it is roughly 250px, not 285. Putting the strip and the health lines above it costs the summary nothing above the fold. If you want a purer action-first page later, moving `#report-card` below `#reviews-card` is a one-block move.

**2. The site details drawer.** Owner and honesty said shrink and gate it; infodesign said demote it to a technical footer; mobile said dissolve it. **My call: dissolve it.** Once Secure and Renews are gone and Hosting/Domain move to Manage plan, there is one row left, and a drawer holding one row is worse than no drawer. Gating a toggle on a row count (the shrink option) is more code than deleting the drawer.

**3. `#bench-card`: cut or keep.** Owner said cut it outright; honesty said keep and fix; infodesign said demote; mobile said restructure the grid. **My call: demote and fix, do not cut.** On the surface that matters it is a collapsed 60-80px header (`.rp-mcol`), so its cost is close to zero until someone chooses to open it, and it is a genuine Growth differentiator. The owner lens's real complaint is copy and a missing button, and both are cheaper to fix than the card is to rebuild later. Note that even the cut version keeps `pullCompetitors`, because `competitors.category` is `bizType` at index.ts:763 and steers all three AI generators.

**4. The Leads tab.** Owner wanted `leads` removed from `REPORT_METRICS` outright because the heading lies and the same series is on the Leads page and the home hero; the others wanted the tab kept and the heading fixed. **My call: keep Leads, fix the heading, and cut `ctr` instead.** Removing a tab because its heading is wrong is fixing the wrong thing, and Leads is the tab closest to money. If four pills is too many at 390px, `ctr` is the one to drop, and the codebase already agrees with itself on this: the comment at 7811-7813 records that click rate "needed the most explaining" and "looked worst", which is why the list was once trimmed to visits only.

**5. The chart's extra layers.** Owner wanted the average line, the projection and the legend all deleted; mobile wanted the legend hidden on phones; the others kept all three. **My call: delete the projection, keep the average.** The dashed average reads without a key. The dotted regression is the one that needs the legend, and it is the one making a claim about the future from 60 noisy days.

**6. Nudges ahead of opportunities.** Owner and infodesign both called `sugQueue`'s ordering a bug, since a Growth client with two nudges can never reach a paid opportunity inside the two-skip cap. **The code says it is deliberate:** the comment at 8178-8180 states that timely ideas go stale and opportunities do not, so seasonal goes first. **My call: keep the ordering, raise the skip cap to 3 for advanced plans.** That preserves the reasoning and removes the structural trap without inverting a decision that was made on purpose. Worth a real answer from you rather than a code change made on a lens's say-so.

**7. `#report-explain`.** Every lens called the comment false and the div dead. It is dead in the portal, but `explain_report` is a complete, live task in ai-assist (index.ts:325-328, `CONTEXT_TASKS` at 209) that nothing anywhere calls. Cutting the div should take the server branch with it, otherwise you leave the same orphan on the other side of the wire.

---

## Do this first

Two batches. Neither needs any reordering, so they can ship today and independently.

**Batch A: deletions, zero visual change, about 45 minutes.**
1. `#report-nav`: markup 3160-3161, CSS 1480-1484, JS 13818-13856, the `buildReportNav()` call at 13808.
2. `#growth-upsell`: markup 3434-3443, CSS 1824-1829, lines 8972-8973, the `.rp-upsell` halves at 1505 and 1522.
3. `#report-explain`: markup 3178-3180, plus the `explain_report` branch in ai-assist.
4. `#secure-row`: markup 3203, JS 14023-14031.
5. Dead odds and ends: `.biz-tile-tag` (1728), `.opp-btn.done` (1896-1897), `window._nudgeMonth` (8820), the two stale gating comments at 1723 and 8370.

**Batch B: correctness, about half a day, each independently shippable.**
6. `sentenceCase` (8794-8803): stop lowercasing the client's business name.
7. Updated stamp (8775): relative date with a year, and a real "never refreshed" state.
8. `clientSiteHref(client)` at 6559: bare-domain clients get their detail rows back.
9. `gc.style.display` (8777): gate on data so a new client's first report is not an error message.
10. `a11y` branch (8849): stop calling a 62 "Good".
11. `sugCard.style.display` (8823): make the empty state reachable; reset `_sugSkips` / `_sugSent` in the two refresh handlers.
12. `IS_PREVIEW` guard in `fileSug` (8235) and `generateSeasonBanner` (8651).
13. `isAdvancedPlan()` guard in `reviewReplyFromRadar` (8129).
14. `loadUptime` (6765-6772): neutral grey state instead of silence, plus the missing `.order()`.
15. `setReportSummary` (4555): preserve the expanded state across a refresh.
16. `emailGrowthReport` (9982): progress bar, and disable both buttons in both handlers.
17. **growth-report/index.ts:752**: wrap the keyword movement loop in `if (search)`. This one is destroying stored history every time a GSC pull fails, so the sooner it lands the less movement data is lost.

## Bigger rework

In dependency order.

- **Split `#growth-card` into a reviews card and a speed card, and reorder the page.** Half a day. The risk is the three `display` paths that reference `#rating-block`, `#review-radar` and `#review-grow`, plus keeping the `rating-block` id intact for the home hero deep link.
- **Merge keywords into the search card and delete the `.dash-search` grid.** Two to three hours, mostly CSS removal (1486, 1501-1507) and the `.split` toggle at 8965-8971.
- **Honest "not connected" states.** The best version is a small server change: `refreshClient` already builds a `diag` object naming exactly which sources came back fresh (index.ts:702-707), and the wording for each gap already exists at 989-992, but `diag` is only used to build a toast that vanishes in four seconds. Persist it as `metrics.sources` inside `refreshClient` (so both the on-demand path at 979 and the monthly cron path at 949 get it), then render one plain-English line per missing source on every page load without anyone tapping Refresh. Rewrite the strings out of admin vocabulary ("our service account has not been added to it") into owner language. About 10 lines server-side, 40 in the portal, half a day including a deploy and one refresh cycle to repopulate.
- **Season card into the nudge queue**, with the takedown-date and double-file fixes. Two hours.
- **Real plan enforcement in ai-assist.** One hour to read `clients.plan` and return 403 for the six gated tasks, plus a portal path that shows the locked panel on a 403 rather than an error toast. Only worth doing if you consider the lock a promise rather than decoration.

Roughly two and a half to three working days end to end, and the first day carries no visual risk at all.

## Do not change

- **`goToReportSection` (4613).** Live: the home hero's Google rating tile deep-links to `rating-block` (9220). Any move of the reviews block must carry that id.
- **`window._reportSearch = s || null` (8907).** It sits outside the `if (card)` block on purpose. Year in Review reads `_reportSearch.monthly` at 12562.
- **`renderPageUsage(m)` (8780).** Inside `renderGrowthMetrics`, feeds the Manage plan pages meter. Easy to lose in a restructure of this function.
- **`window._siteDown` in `loadUptime` (6777).** Drives the support-channel suggestion (4679) and the "my site is down" copy (6788-6796). Any rewrite of the pill must keep publishing it, and must keep publishing it only from a check under 30 minutes old.
- **`clients.host_provider` detection.** Even with the row off the report, `isExistingSite` (7938-7941) reads it and drops the page allowance to 8. Keep detecting and storing.
- **`pullCompetitors` in growth-report.** `competitors.category` is `bizType` at index.ts:763 and is passed into all three AI generators. Remove it and every piece of AI copy on the page quietly gets more generic.
- **`validScore` (8834), the `mx !== null` guard (14034), the `.filter(r => r.client_note)` in `loadSiteHealth` (6896), the 45-day floor.** These are the four places the page already refuses to show something it cannot stand behind. They are the standard, not the debt.
- **`lockedPreview`, `metricUnlocked`, `FREE_GRAPH_METRICS`, the deliberate blanking of locked totals.** All carry comments explaining decisions already made and re-made. Showing Essential a Clicks tab that upsells on tap is stated as the point.
- **`.rp-mcol` max-height cap (1720).** Do not remove it without replacing it; the comment records that content was already clipped once at the old 1400px limit.
- **`IS_PREVIEW` guards that already exist** (`fileRadarRequest` 8144, `putSeasonBanner` 8681). Add to them, do not touch them.

## Practical notes

There is no build step and no test suite: this is one 14,521-line file deployed with `wrangler pages deploy portal`. Every line number above shifts as soon as you edit above it, so apply changes bottom-up within the file, or re-grep between edits. Validate each batch in the browser against three states that are all easy to reach and all currently broken in different ways: a Growth client with full data, an Essential client (the locked previews), and a client with a `site_url` but no `client_metrics` row at all, which is the state that currently opens with an accusation that their website blocks Google.