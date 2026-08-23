# WebEaze social media

One batch of square posts per month. Everything is generated from code, so a new
month is a copied file and two commands, not a redesign.

    social-media/
      lib.js                  shared design system (CSS + layout helpers)
      build.js                turns a month file into HTML pages
      render.sh               screenshots those pages to 1080x1080 PNGs
      months/
        aug-sep-2026.js       content for that month
        sep-oct-2026.js
      aug-sep-2026/
        png/                  <- the files you post
        captions.md           <- the words you paste
        posts.html            contact sheet, open it to see the whole batch
        single/               one page per post, used by render.sh

## Making next month

    cp months/sep-oct-2026.js months/oct-nov-2026.js
    # edit the posts array: change the copy, swap a client screenshot, add a holiday
    node build.js oct-nov-2026
    ./render.sh oct-nov-2026

Then write `oct-nov-2026/captions.md` alongside it. That is the whole process.

## Layout helpers

Available inside a post's `inner()`:

| helper | what it makes |
|---|---|
| `rows([[label, value], ...])` | white rows with an accent value on the right |
| `checks([...])` | ticked list |
| `steps([[num, head, sub], ...])` | numbered steps |
| `stats([[big, small], ...])` | stat stack, used in split layouts |
| `tags([...])` | rounded pill cloud |
| `pills([...])` | solid accent pills |
| `bars([[label, width, value, highlight], ...])` | comparison bars |
| `browser(url, imgPath, height)` | client site in a browser frame |
| `options([[letter, text, ico.x], ...])` | lettered A/B/C/D answer cards |
| `prompt('Tell us below')` | arrow + call to answer, for discussion posts |
| `ico.search` etc | small line icons: search, chat, thumb, repeat, cal, dust, spark, phone |

Set `bg:'images/...'` on a post for a full-bleed photo with a left-weighted scrim,
which also left-aligns and bottom-weights the copy. Used for the Labor Day card.

Set `cls` to `cream`, `ink` or `plum`. Aim for a dark or purple card roughly every
third post so a grid view has rhythm rather than fifteen cream squares.

## Mix

Aim for roughly:

- 3 discussion posts per batch (questions people answer in the comments)
- 2 client showcases, rotating which client
- the rest offer, proof and seasonal

Discussion posts are the ones that get replies, so spread them through the month
rather than running them back to back.

## House rules

- Every number must come from the live site. No invented stats, no review counts,
  no "trusted by X businesses".
- Only Anthony B.'s quote is a real WebEaze testimonial. Client sites carry reviews
  of *those businesses*, which are not ours to borrow.
- Client screenshots live in `images/case-studies/`. Five are available: Grass Goats,
  Bear Carpet Care, Galaxy Gymnastics, Clam Tavern, Ibis Prep.
- Check holiday dates before writing a holiday post. Labor Day 2026 is Monday
  September 7, verified, not assumed.

## Verified facts to draw on

Essential $169/mo · Growth $249/mo · one-time setup $199 · no contract
One-time help $149 / $299 / $799 · free preview in 48 hours · live in 5 to 14 days
Most content updates in 2 working days · Mon to Fri, 9 to 5 ET, closed major US holidays
Agency $5k to $25k upfront · freelancer $1.5k to $8k
Areas: DE, MD, PA, NJ, VA, Washington D.C.
