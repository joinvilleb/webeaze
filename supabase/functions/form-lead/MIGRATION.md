# Moving a client form onto the WebEaze form endpoint

The endpoint is a drop-in replacement for Formspree. It speaks the same conventions (`_gotcha`,
`_subject`, `_next`), so for most forms the migration is one attribute.

```
action="https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/form-lead/<client user_id>"
```

The `<client user_id>` is already on every page of the site, in the `data-key` of the track.js tag.

## Three rules

1. **The form must carry a real `action`, even if its own JavaScript does the POST.** track.js reads
   the action to know the server is already recording this submission. Without it the lead is counted
   twice, once by the browser and once by the server.
2. **A native-POST form needs somewhere to land.** A cross-origin POST sends `Referer` as the origin
   only, so the endpoint cannot know which page the visitor was on. Without `_next` they are returned
   to the site's home page with `?sent=1`, which on most sites shows no confirmation at all and
   invites a second submission. Add a hidden `_next` pointing at a thank-you page on the client's own
   domain. Off-domain values are refused.
3. **Add `_page` if the page matters in reporting.** Same reason: the path is not knowable from
   headers. `<input type="hidden" name="_page" value="/request-a-quote/">`

## Per site

| Site | Forms | What it needs |
|---|---|---|
| bearcarpetcare.com | 1 | **Done locally, not pushed.** `action` added in `build-pages.py` + `contact.html`; `js/contact.js` now reads the endpoint off the form. Re-minified. |
| ibisrepairgroup.com | 3 (EN + ES + the exit-intent form in `js/main.js`) | `action` swap only. Its JS does `fetch(this.action, {Accept: application/json})` and checks `r.ok`, which this endpoint satisfies. |
| freshlookinteriorsdcs.com | 2 | `action` swap only. Same fetch-and-check-`r.ok` shape. Both forms take file uploads, which the endpoint stores and links from the email. |
| grassgoats.com | 6 across 4 pages | `action` swap **plus `_next`** — these are native POSTs with no JS handler, so today they would land on the home page with no confirmation. |
| hairresponse.com | 1 | `action` swap **plus `_next`**. Native POST. |
| galaxygymnast.com | 2 | `action` swap **plus `_next`**. Native POST. Its Google Form and cross-origin iframe cannot be captured by anything and would need replacing with real forms. |
| clamtavern.net | 0 | Nothing to do. |

## Before the first form is switched over

1. `supabase functions deploy form-lead --no-verify-jwt`
2. Run `supabase/form_uploads.sql` (the private bucket for attachments)
3. Run `supabase/lead_events.sql` again (adds the `attachments` column)
4. Confirm `RESEND_API_KEY` is set on the `form-lead` function

**Order matters.** Pointing a form at an endpoint that is not deployed yet turns a working contact
form into an error message. Deploy first, submit one real test through the live form, confirm it
arrives in the inbox and in the portal, and only then push the next site.
