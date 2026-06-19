# Waitlist Integration (Amazon SES) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `mailto:` hack on both waitlist forms in `index.html` with a Cloudflare Worker that sends a notification email via Amazon SES when someone joins the waitlist.

**Architecture:** A Cloudflare Worker at `POST /subscribe` receives the email from the browser, validates it, then signs and sends a request to AWS SES v2 using AWS Signature V4 (implemented via Web Crypto API — no npm dependencies). AWS credentials stored as Worker secrets.

**Tech Stack:** Cloudflare Workers (ES modules), Wrangler CLI v4, AWS SES v2 SendEmail API, AWS Signature V4 (Web Crypto), vanilla JS in `index.html`

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `worker/wrangler.toml` | Add SES env vars, remove old SendGrid vars |
| Modify | `worker/index.js` | Replace SendGrid call with SES Sig V4 implementation |
| Modify | `index.html:119` | Add `.form-error` CSS rule |
| Modify | `index.html:537-565` | Replace handleSubmit functions with fetch-based flow |

---

## Task 1: Update wrangler.toml for SES

**Files:**
- Modify: `worker/wrangler.toml`

- [ ] **Step 1: Replace contents of worker/wrangler.toml**

```toml
name = "smudgetv-subscribe"
main = "index.js"
compatibility_date = "2024-09-23"

[vars]
AWS_REGION = "us-east-1"
SES_FROM_EMAIL = "noreply@smudgetv.com"
SES_TO_EMAIL = "helpdesk@smudgetv.com"
```

- [ ] **Step 2: Verify wrangler can parse the config**

```bash
cd worker && wrangler deploy --dry-run
```

Expected: `Total Upload:` line with no errors.

- [ ] **Step 3: Commit**

```bash
cd .. && git add worker/wrangler.toml && git commit -m "feat: update wrangler.toml for Amazon SES"
```

---

## Task 2: Implement SES Worker

**Files:**
- Modify: `worker/index.js`

- [ ] **Step 1: Replace entire contents of worker/index.js**

```js
const ALLOWED_ORIGINS = ['https://smudgetv.com', 'https://www.smudgetv.com'];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256hex(msg) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  return toHex(digest);
}

async function hmac(key, msg) {
  const enc = new TextEncoder();
  const keyData = typeof key === 'string' ? enc.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg));
}

async function getSigningKey(secret, dateStamp, region, service) {
  const kDate = await hmac('AWS4' + secret, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

async function sendSESEmail(env, toEmail) {
  const region = env.AWS_REGION;
  const service = 'ses';
  const host = `email.${region}.amazonaws.com`;
  const path = '/v2/email/outbound-emails';

  const payload = JSON.stringify({
    FromEmailAddress: env.SES_FROM_EMAIL,
    Destination: { ToAddresses: [env.SES_TO_EMAIL] },
    Content: {
      Simple: {
        Subject: { Data: 'New Waitlist Signup', Charset: 'UTF-8' },
        Body: {
          Text: {
            Data: `New waitlist signup received.\n\nEmail: ${toEmail}`,
            Charset: 'UTF-8',
          },
        },
      },
    },
  });

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256hex(payload);

  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonicalRequest = [
    'POST', path, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope,
    await sha256hex(canonicalRequest),
  ].join('\n');

  const signingKey = await getSigningKey(env.AWS_SECRET_ACCESS_KEY, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authHeader = `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Amz-Date': amzDate,
      Authorization: authHeader,
    },
    body: payload,
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = { 'Content-Type': 'application/json', ...corsHeaders(origin) };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
    }

    const email = (body.email || '').trim().toLowerCase();
    if (!email || !isValidEmail(email)) {
      return new Response(JSON.stringify({ error: 'Invalid email address' }), { status: 400, headers });
    }

    const sesResponse = await sendSESEmail(env, email);
    if (!sesResponse.ok) {
      return new Response(
        JSON.stringify({ error: 'Failed to subscribe. Please try again.' }),
        { status: 500, headers }
      );
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  },
};
```

- [ ] **Step 2: Start local dev server**

```bash
cd worker && wrangler dev --local
```

Expected: `Ready on http://localhost:8787`. Run in background.

- [ ] **Step 3: Test — missing body returns 400**

```bash
curl -s -X POST http://localhost:8787/subscribe \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool
```

Expected: `{ "error": "Invalid email address" }`

- [ ] **Step 4: Test — invalid email returns 400**

```bash
curl -s -X POST http://localhost:8787/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email": "notanemail"}' | python3 -m json.tool
```

Expected: `{ "error": "Invalid email address" }`

- [ ] **Step 5: Test — valid email with no secrets set returns 500**

```bash
curl -s -X POST http://localhost:8787/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}' | python3 -m json.tool
```

Expected: `{ "error": "Failed to subscribe. Please try again." }` — correct, because AWS secrets are not configured in local dev.

- [ ] **Step 6: Test — wrong method returns 405**

```bash
curl -s -X GET http://localhost:8787/subscribe | python3 -m json.tool
```

Expected: `{ "error": "Method not allowed" }`

- [ ] **Step 7: Test — OPTIONS preflight returns 204**

```bash
curl -s -o /dev/null -w "%{http_code}" -X OPTIONS http://localhost:8787/subscribe \
  -H "Origin: https://smudgetv.com" \
  -H "Access-Control-Request-Method: POST"
```

Expected: `204`

- [ ] **Step 8: Stop wrangler dev (Ctrl+C) and commit**

```bash
cd .. && git add worker/index.js && git commit -m "feat: implement SES email notification via AWS Signature V4"
```

---

## Task 3: Deploy the Worker

**Files:** No file changes — deployment only.

- [ ] **Step 1: Store AWS credentials as Worker secrets**

```bash
cd worker && wrangler secret put AWS_ACCESS_KEY_ID
```

When prompted, enter: `AKIAVES3B6EBWFZCHNF3`

```bash
wrangler secret put AWS_SECRET_ACCESS_KEY
```

When prompted, enter the secret access key.

- [ ] **Step 2: Deploy**

```bash
wrangler deploy
```

Expected output includes:
```
Published smudgetv-subscribe (X.XXs)
  https://smudgetv-subscribe.<account>.workers.dev
```

Copy the URL — needed for Task 4.

- [ ] **Step 3: Smoke-test — invalid email**

```bash
curl -s -X POST https://smudgetv-subscribe.<account>.workers.dev/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email": "bad"}' | python3 -m json.tool
```

Expected: `{ "error": "Invalid email address" }`

- [ ] **Step 4: Smoke-test — real email**

```bash
curl -s -X POST https://smudgetv-subscribe.<account>.workers.dev/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email": "test@smudgetv.com"}' | python3 -m json.tool
```

Expected: `{ "success": true }` — and a notification email arrives at `helpdesk@smudgetv.com`.

---

## Task 4: Update index.html

**Files:**
- Modify: `index.html:119` — add `.form-error` CSS rule
- Modify: `index.html:537-565` — replace both handleSubmit functions

- [ ] **Step 1: Add .form-error CSS**

Find line 119 in `index.html`:
```css
.success-msg { display: none; font-size: 1rem; color: var(--mint); margin-top: 16px; text-align: center; }
```

Add immediately after:
```css
.form-error { font-size: 0.82rem; color: #f87171; margin-top: 8px; text-align: center; }
```

- [ ] **Step 2: Replace the script block (lines 537–565)**

Find and replace this entire block:

```html
  <script>
    function handleSubmit() {
      var email = document.getElementById('email').value.trim();
      if (!email || !email.includes('@')) {
        document.getElementById('email').focus();
        return;
      }
      document.getElementById('successMsg').style.display = 'block';
      document.getElementById('email').value = '';
      var link = document.createElement('a');
      link.href = 'mailto:helpdesk@smudgetv.com?subject=Waitlist+Signup&body=Please+add+me+to+the+Smudge+waitlist:+' + encodeURIComponent(email);
      link.click();
    }
    function handleSubmit2() {
      var email = document.getElementById('email2').value.trim();
      if (!email || !email.includes('@')) {
        document.getElementById('email2').focus();
        return;
      }
      document.getElementById('email2').value = '';
      var link = document.createElement('a');
      link.href = 'mailto:helpdesk@smudgetv.com?subject=Waitlist+Signup&body=Please+add+me+to+the+Smudge+waitlist:+' + encodeURIComponent(email);
      link.click();
    }
    document.getElementById('email').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') handleSubmit();
    });
    document.getElementById('email2').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') handleSubmit2();
    });
  </script>
```

Replace with (substitute your actual Worker URL from Task 3 Step 2):

```html
  <script>
    var WORKER_URL = 'https://smudgetv-subscribe.<account>.workers.dev/subscribe';

    function clearError(formRow) {
      var existing = formRow.parentElement.querySelector('.form-error');
      if (existing) existing.remove();
    }

    function showError(formRow, message) {
      clearError(formRow);
      var msg = document.createElement('p');
      msg.className = 'form-error';
      msg.textContent = message;
      formRow.insertAdjacentElement('afterend', msg);
    }

    async function subscribeEmail(inputId, btn, successId) {
      var input = document.getElementById(inputId);
      var email = input.value.trim();
      var formRow = btn.closest('.form-row');

      clearError(formRow);

      if (!email || !email.includes('@')) {
        input.focus();
        return;
      }

      var originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Adding…';

      try {
        var res = await fetch(WORKER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email }),
        });
        var data = await res.json();

        if (res.ok && data.success) {
          input.value = '';
          if (successId) {
            document.getElementById(successId).style.display = 'block';
          } else {
            var ok = document.createElement('p');
            ok.className = 'success-msg';
            ok.style.display = 'block';
            ok.textContent = "You’re on the list — we’ll be in touch!";
            formRow.insertAdjacentElement('afterend', ok);
          }
        } else {
          showError(formRow, data.error || 'Something went wrong — please try again.');
        }
      } catch (e) {
        showError(formRow, 'Something went wrong — please try again.');
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }

    function handleSubmit() {
      var btn = document.querySelector('#email').closest('.form-row').querySelector('.btn-primary');
      subscribeEmail('email', btn, 'successMsg');
    }

    function handleSubmit2() {
      var btn = document.querySelector('#email2').closest('.form-row').querySelector('.btn-primary');
      subscribeEmail('email2', btn, null);
    }

    document.getElementById('email').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') handleSubmit();
    });
    document.getElementById('email2').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') handleSubmit2();
    });
  </script>
```

- [ ] **Step 3: Test locally**

```bash
cd /Users/junbarcellano/Projects/smudge_tv && python3 -m http.server 3000
```

Open `http://localhost:3000` in browser. Test:
1. Hero form: type bad email → click "Notify Me" → input focuses (client validation)
2. Hero form: type real email → click "Notify Me" → button shows "Adding…" → success message appears
3. Bottom form: same flow, success message injected inline
4. Error state: temporarily set `WORKER_URL` to a bad URL → confirm red error message + button re-enables

- [ ] **Step 4: Commit and push**

```bash
git add index.html && git commit -m "feat: replace mailto waitlist forms with SES-backed fetch"
git push origin feat/sendgrid-waitlist
```

---

## Post-deployment checklist

- [ ] SES domain verification status shows `SUCCESS` (check: `aws sesv2 get-email-identity --email-identity smudgetv.com --profile smudgetv --region us-east-1`)
- [ ] Notification email arrives at `helpdesk@smudgetv.com` after live form submit
- [ ] Test from hosted site (not localhost) to confirm CORS headers pass
- [ ] If AWS account is still in SES sandbox, request production access: AWS Console → SES → Account dashboard → Request production access
