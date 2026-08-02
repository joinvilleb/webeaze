# WebEaze

**WebEaze** is a subscription-based website service for small businesses. We build your website, manage it on an ongoing basis, and handle every update so you don't have to think about it.

Live site: [webeaze.io](https://webeaze.io)

---

## What this repo is

This is the full codebase for the WebEaze marketing site. It includes all public-facing pages, client-facing tools, legal documents, and internal pages. Everything is static HTML, CSS, and JavaScript. There's no build step and no framework required.

---

## What WebEaze does

WebEaze builds and manages websites for small businesses under a simple monthly or annual plan. Clients get a custom website, unlimited content updates, hosting, SEO basics, and ongoing support, all for one flat price.

Plans currently available:

- **Essential** ($169/mo): Up to 3 pages, unlimited updates, basic SEO, email support, monthly performance reports
- **Growth** ($249/mo): Up to 6 pages, priority support, Google Business Profile management, Total Access Support, online review management

One-time projects and add-ons (ads, AI chatbot, ecommerce, etc.) are also available for clients who need something outside the standard plans.

---

## Tech stack

- HTML5, CSS3, vanilla JavaScript
- Bootstrap 4 (select pages)
- Font Awesome (icons)
- HubSpot (forms and CRM)
- Stripe (billing and subscriptions)
- Google Analytics 4 and Google Tag Manager
- GitHub Pages for hosting

Pages are intentionally lightweight. No bundlers, no frameworks, no unnecessary dependencies.

---

## Pages overview

| Page | Purpose |
|------|---------|
| `index.html` | Homepage and main marketing page |
| `pricing.html` | Plan comparison and pricing |
| `services.html` | Services overview |
| `about.html` | Company background |
| `help.html` | Help center with full article library and search |
| `faq.html` | Frequently asked questions |
| `consultation.html` | Free mockup call booking |
| `contact-us.html` | Contact form and support options |
| `status.html` | Service status and holiday schedule |
| `samples.html` | Portfolio and sample sites |
| `website-request.html` | Client update request portal |
| `my-plan.html` | Plan management page for existing clients |
| `fee-schedule.html` | Full breakdown of fees and add-on pricing |
| `documents.html` | Plan documents and comparison PDFs |
| `terms.html` | Terms of Service |
| `cancellation-policy.html` | Cancellation policy |
| `acceptable-use-policy.html` | Acceptable use policy |
| `ads.html` | Ad management add-on details |
| `ai.html` | AI chatbot add-on details |
| `domains.html` | Domain setup and management info |
| `geo pages` | Local SEO pages for DC, MD, VA, PA, NJ, DE |
| `client samples` | Sample sites for individual clients |

---

## Local development

There's no build process. Open any HTML file directly in a browser, or serve locally with any static server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

---

## Notes

- All plans are billed through Stripe. Billing portal: billing.stripe.com
- Client update requests go through HubSpot forms embedded on `website-request.html`
- The help center (`help.html`) has a full JS-powered search, article read history, and personalized recommendations built into the page
- Holiday and status logic on `status.html` uses ET timezone. Add `?preview=today`, `?preview=soon`, or `?preview=past` to test different states
- SEO and AEO schema (FAQPage, BreadcrumbList, AggregateRating, LocalBusiness) is embedded as JSON-LD in each page's `<head>`
