# Bake 350°, Open Graph image

1200x630 (1.91:1), the size Facebook, LinkedIn, X and iMessage all use for link previews.
Both are well under the 8MB limit.

Palette and copy taken from bake350degrees.com: tan `#a3773b`, brown `#685136`,
deep brown `#5a3b1c`, caramel `#c67b5b`. The mission line is their own, from the
site's meta description. Cookie and logo are their own assets.

## Which to use

**`og-a.png`** is the safer default. Cream ground, logo, their mission line, and the
red velvet cookie bleeding off the right. Light backgrounds hold up better in dark-mode
feeds and against the white cards Facebook and LinkedIn draw around previews.

**`og-b.png`** is warmer and more appetising, brown ground with the cookie on the left.
Good if they want the food to lead.

## The actual problem this fixes

Their current tag points at the logo file:

    <meta property="og:image" content=".../bake350-offical-logo-png-200x57.png">

That is 200x57. Facebook needs at least 200x200 to render a large card, so a link to
their site currently shows either a tiny thumbnail or nothing at all.

## What to add

Upload the chosen file to their media library, then set:

    <meta property="og:image" content="https://bake350degrees.com/wp-content/uploads/og-a.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="Bake 350 degrees, Libertyville baked goods">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:image" content="https://bake350degrees.com/wp-content/uploads/og-a.png">

After it is live, run the URL through Facebook's Sharing Debugger and press
"Scrape Again". Facebook caches previews hard and will keep showing the old one otherwise.

## Editing

`og.html` holds both designs. Edit, then re-render each at 1200x630, scale factor 1.
