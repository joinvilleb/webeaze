# Ibis Prep, Google Business Profile cover

Built from ibisprep.com: brand blue `#0081cc`, navy `#05244f`, Poppins,
their circle ibis logo, and their own slogan "Every Student. Every Subject. Every Goal."

All three are 2400x1350 (16:9), which is above Google's recommended 1024x576 so it
stays sharp on retina, and well inside the 5MB limit.

## Which to upload

**Use `cover-a.png`.** Google crops the cover differently across search, Maps and mobile,
and A is the only one that survives it. I tested all three against a centred 4:3 and a
centred 1:1 crop:

| | 4:3 crop | 1:1 crop |
|---|---|---|
| **A** centred | logo, all three slogan lines and the strapline all survive | same, still complete |
| **B** split | loses most of the logo panel | logo nearly gone, body text cut mid-word |
| **C** left-weighted | "Every Student" becomes "very Student" | wordmark reduced to "rep" |

`cover-b.png` is still worth keeping. It is the strongest of the three at full 16:9,
so it works as a website hero banner, an email header, or a LinkedIn cover, anywhere
the whole frame is actually shown.

## Editing

Open `cover.html` in a browser to see all three side by side. Edit the copy or colours
there, then re-render each variant at 1200x675 with a device scale factor of 2.

Logo source: the circle mark from their site, pulled at 800x800 (`logo.png`).
