# SendGrid Waitlist Integration — Design Spec

**Date:** 2026-06-19  
**Project:** Smudge TV (`smudgetv_website`)  
**Status:** Approved

---

## Overview

Replace the current `mailto:` hack on the two waitlist forms in `index.html` with a proper API-backed flow. A Cloudflare Worker acts as a secure middleman between the browser and SendGrid's Marketing Campaigns API, keeping the API key off the client.

---

## Architecture

Three components:

| Component | File | Purpose |
|---|---|---|
| Cloudflare Worker | `worker/index.js` | Accepts POST, validates email, calls SendGrid |
| Worker config | `worker/wrangler.toml` | Deployment config, non-secret env vars |
| Frontend | `index.html` | Replaces mailto with fetch(), shows state |

---

## Cloudflare Worker

**Route:** `POST /subscribe`  
**Deployed at:** `subscribe.smudgetv.workers.dev` (or custom subdomain)

### Request

```json
POST /subscribe
Content-Type: application/json

{ "email": "user@example.com" }
```

### Behaviour

1. Reject non-POST requests with 405.
2. Parse JSON body; return 400 if missing or malformed.
3. Validate email format server-side (regex); return 400 if invalid.
4. Call `PUT https://api.sendgrid.com/v3/marketing/contacts` with:
   ```json
   {
     "list_ids": ["<SENDGRID_LIST_ID>"],
     "contacts": [{ "email": "<email>" }]
   }
   ```
5. SendGrid returns 202 (async accepted) → Worker returns `{ "success": true }` with 200.
6. Any non-2xx from SendGrid → Worker returns `{ "error": "Failed to subscribe. Please try again." }` with 500.

### CORS

`Access-Control-Allow-Origin` locked to `https://smudgetv.com` (and `https://www.smudgetv.com`). Preflight OPTIONS handled.

### Secrets & Config

| Name | Type | How set |
|---|---|---|
| `SENDGRID_API_KEY` | Worker secret | `wrangler secret put SENDGRID_API_KEY` |
| `SENDGRID_LIST_ID` | Env var | `wrangler.toml` `[vars]` section |

---

## Frontend Changes (`index.html`)

### What changes

- `handleSubmit()` and `handleSubmit2()` replaced by a shared `subscribeEmail(emailInputId, buttonEl)` function.
- Both buttons call `subscribeEmail()` with their respective input ID.
- `mailto:` link creation removed entirely.

### State machine per form

| State | Button text | Input |
|---|---|---|
| Idle | "Notify Me" / "Join the List" | Enabled |
| Loading | "Adding…" | Disabled |
| Success | "Notify Me" / "Join the List" | Cleared, re-enabled |
| Error | "Notify Me" / "Join the List" | Retains value, re-enabled |

### Success feedback

Hero form: existing `#successMsg` div shown.  
Bottom form: inline message injected below the form row (same style as `.form-footnote`).

### Error feedback

Inline message below the relevant form: `"Something went wrong — please try again."` Disappears on the next successful submit.

---

## Data Flow

```
User types email → clicks button (or presses Enter)
  → client validates (non-empty, contains @)
  → button disabled, text → "Adding…"
  → fetch POST /subscribe { email }
      → Worker validates email (regex)
      → Worker PUT /v3/marketing/contacts (SendGrid)
          → 202 Accepted
      → Worker returns { success: true }
  → show success message, clear input, re-enable button

On any fetch/Worker/SendGrid error:
  → show inline error, re-enable button (input value preserved)
```

---

## Error Handling

| Failure point | Handling |
|---|---|
| Empty / malformed email (client) | Focus input, do nothing |
| Empty / malformed email (server) | 400, generic error shown |
| SendGrid non-2xx | 500, generic retry message shown |
| Network failure (fetch throws) | catch block, generic retry message shown |

SendGrid's 202 is treated as success — contact addition is async on their side. No special handling needed.

---

## Out of Scope

- Confirmation email to the subscriber (can be added later as Approach B)
- Duplicate detection (SendGrid deduplicates contacts natively)
- CAPTCHA / bot protection (can be layered on later with Cloudflare Turnstile)

---

## Setup Steps (for implementer)

1. Install Wrangler CLI: `npm install -g wrangler`
2. Authenticate: `wrangler login`
3. Create `worker/` directory with `wrangler.toml` and `index.js`
4. Set secret: `wrangler secret put SENDGRID_API_KEY`
5. Set list ID in `wrangler.toml` `[vars]`
6. Deploy: `wrangler deploy`
7. Update `index.html` Worker URL to the deployed endpoint
8. Test end-to-end before pushing
