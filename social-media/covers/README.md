# WebEaze cover images

`facebook-a.png` and `facebook-b.png`, both 1640x624, which is 2x the 820x312 slot
Facebook uses on desktop so they stay sharp on retina.

**Both survive Facebook's mobile crop.** Mobile shows a narrower centre slice of the
cover, so everything sits inside a 1180px safe area rather than running to the edges.
I checked each against that crop and nothing important is lost.

- **A**, cream: friendlier and more distinctive. The little browser card with a "Get a
  quote" button reads instantly as "we make websites" without spelling it out.
- **B**, purple: more direct. Carries the wordmark, the offer and three proof pills,
  so it works harder if the cover is doing sales work.

## Editing

Open `facebook.html` to see both. Change the copy or colours there, then re-render each
variant at 1640x624. Keep new content inside `.safe` or the mobile crop will eat it.

The logo art is dark, so on the purple version it sits in a white circle badge.
Dropping it straight onto purple turns it into a smudge.
