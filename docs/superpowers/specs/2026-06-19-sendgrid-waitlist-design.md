# Waitlist Integration — Design Spec

**Date:** 2026-06-19 (updated: switched from SendGrid to Amazon SES)
**Project:** Smudge TV (`smudgetv_website`)  
**Status:** Approved

---

## Overview

Replace the current `mailto:` hack on the two waitlist forms in `index.html` with a proper API-backed flow. A Cloudflare Worker acts as a secure middleman between the browser and Amazon SES, sending a notification email to `helpdesk@smudgetv.com` for each signup. AWS credentials are stored as Worker secrets — never exposed to the browser.

---

## Architecture

Three components:

| Component | File | Purpose |
|---|---|---|
| Cloudflare Worker | `worker/index.js` | Accepts POST, validates email, calls SES SendEmail |
| Worker config | `worker/wrangler.toml` | Deployment config, non-secret env vars |
| Frontend | `index.html` | Replaces mailto with fetch(), shows state |

---

## Cloudflare Worker

**Route:** `POST /subscribe`  
**Deployed at:** `smudgetv-subscribe.<account>.workers.dev`

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
4. Sign and send a request to AWS SES v2 `POST /v2/email/outbound-emails` using AWS Signature V4 (HMAC-SHA256 via Web Crypto API — no external dependencies).
5. SES returns 200 → Worker returns `{ "success": true }` with 200.
6. Any non-2xx from SES → Worker returns `{ "error": "Failed to subscribe. Please try again." }` with 500.

### SES Email payload

```json
{
  "FromEmailAddress": "noreply@smudgetv.com",
  "Destination": { "ToAddresses": ["helpdesk@smudgetv.com"] },
  "Content": {
    "Simple": {
      "Subject": { "Data": "New Waitlist Signup", "Charset": "UTF-8" },
      "Body": {
        "Text": {
          "Data": "New waitlist signup received.\n\nEmail: <submitted-email>",
          "Charset": "UTF-8"
        }
      }
    }
  }
}
```

### CORS

`Access-Control-Allow-Origin` locked to `https://smudgetv.com` and `https://www.smudgetv.com`. Preflight OPTIONS handled with 204.

### Secrets & Config

| Name | Type | How set |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | Worker secret | `wrangler secret put AWS_ACCESS_KEY_ID` |
| `AWS_SECRET_ACCESS_KEY` | Worker secret | `wrangler secret put AWS_SECRET_ACCESS_KEY` |
| `AWS_REGION` | Env var | `wrangler.toml` `[vars]` |
| `SES_FROM_EMAIL` | Env var | `wrangler.toml` `[vars]` |
| `SES_TO_EMAIL` | Env var | `wrangler.toml` `[vars]` |

### AWS Signature V4 signing

The Worker implements Signature V4 using only the Web Crypto API (`crypto.subtle.importKey`, `crypto.subtle.sign` with HMAC-SHA256, `crypto.subtle.digest` with SHA-256). No npm packages required — the Worker stays dependency-free.

---

## Frontend Changes (`index.html`)

### What changes

- `handleSubmit()` and `handleSubmit2()` replaced by a shared `subscribeEmail(inputId, btn, successId)` function.
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

Hero form: existing `#successMsg` element shown.  
Bottom form: inline success message injected below the form row.

### Error feedback

Inline `.form-error` message below the relevant form. Cleared on next submit attempt.

---

## Data Flow

```
User types email → clicks button (or presses Enter)
  → client validates (non-empty, contains @)
  → button disabled, text → "Adding…"
  → fetch POST /subscribe { email }
      → Worker validates email (server-side regex)
      → Worker signs SES SendEmail request (AWS Sig V4)
      → SES sends notification to helpdesk@smudgetv.com
      → Worker returns { success: true }
  → show success message, clear input, re-enable button

On any fetch/Worker/SES error:
  → show inline error, re-enable button (input value preserved)
```

---

## Error Handling

| Failure point | Handling |
|---|---|
| Empty / malformed email (client) | Focus input, do nothing |
| Empty / malformed email (server) | 400, generic error shown |
| SES non-2xx | 500, generic retry message shown |
| Network failure (fetch throws) | catch block, generic retry message shown |

---

## SES Domain Setup (completed)

- Domain `smudgetv.com` verified in AWS SES (us-east-1)
- 3 DKIM CNAME records added to DNS — verification pending (5–30 min)
- AWS IAM user `smudgetv-ses` created with `AmazonSESFullAccess`
- AWS profile `smudgetv` configured locally

---

## Out of Scope

- Confirmation email to the subscriber (can be added later)
- SES Contact List management (can be added later)
- CAPTCHA / bot protection (can be layered on later with Cloudflare Turnstile)

---

## Setup Steps (for implementer)

1. Wrangler already installed (`v4.102.0`) and `worker/` scaffold exists
2. Update `worker/wrangler.toml` — add SES env vars
3. Implement `worker/index.js` — replace SendGrid call with SES Sig V4 call
4. Set secrets: `wrangler secret put AWS_ACCESS_KEY_ID` and `wrangler secret put AWS_SECRET_ACCESS_KEY`
5. Deploy: `wrangler deploy` (from `worker/` directory)
6. Update `index.html` Worker URL to deployed endpoint
7. Test end-to-end
