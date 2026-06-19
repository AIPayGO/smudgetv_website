# SendGrid Waitlist Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `mailto:` hack on both waitlist forms in `index.html` with a Cloudflare Worker that adds signups to a SendGrid Marketing Campaigns contact list.

**Architecture:** A Cloudflare Worker at `POST /subscribe` receives the email from the browser, validates it, and calls the SendGrid `PUT /v3/marketing/contacts` API. The `SENDGRID_API_KEY` is stored as a Worker secret (never in source). Both forms in `index.html` are updated to use `fetch()` with loading/success/error states.

**Tech Stack:** Cloudflare Workers (ES modules), Wrangler CLI, SendGrid Marketing Campaigns API v3, vanilla JS in `index.html`

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `worker/wrangler.toml` | Worker name, routes, non-secret env vars |
| Create | `worker/index.js` | POST /subscribe handler — validate + call SendGrid |
| Modify | `index.html:537-565` | Replace handleSubmit functions with fetch-based flow |

---

## Prerequisites (do these before Task 1)

- [ ] Install Wrangler CLI globally: `npm install -g wrangler`
- [ ] Authenticate with Cloudflare: `wrangler login` (opens browser)
- [ ] Have your SendGrid API key ready (must have **Marketing** → **Contacts** write permission)
- [ ] Have your SendGrid List ID ready: SendGrid dashboard → Marketing → Lists → click your list → copy the ID from the URL

---

## Task 1: Create the Worker project structure

**Files:**
- Create: `worker/wrangler.toml`
- Create: `worker/index.js` (empty stub)

- [ ] **Step 1: Create the worker directory and wrangler.toml**

Create `worker/wrangler.toml` with this exact content — replace `YOUR_LIST_ID_HERE` with your actual SendGrid list ID:

```toml
name = "smudgetv-subscribe"
main = "index.js"
compatibility_date = "2024-09-23"

[vars]
SENDGRID_LIST_ID = "YOUR_LIST_ID_HERE"
```

- [ ] **Step 2: Create an empty worker stub**

Create `worker/index.js`:

```js
export default {
  async fetch(request, env) {
    return new Response('ok');
  },
};
```

- [ ] **Step 3: Verify wrangler can read the config**

```bash
cd worker && wrangler deploy --dry-run
```

Expected output includes: `Total Upload: XX KiB` and no errors. If you see "authentication error", run `wrangler login` first.

- [ ] **Step 4: Commit**

```bash
cd .. && git add worker/ && git commit -m "feat: scaffold Cloudflare Worker project"
```

---

## Task 2: Implement the Worker

**Files:**
- Modify: `worker/index.js`

- [ ] **Step 1: Replace the stub with the full Worker implementation**

Replace the entire contents of `worker/index.js`:

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

    const sgResponse = await fetch('https://api.sendgrid.com/v3/marketing/contacts', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        list_ids: [env.SENDGRID_LIST_ID],
        contacts: [{ email }],
      }),
    });

    if (!sgResponse.ok) {
      return new Response(
        JSON.stringify({ error: 'Failed to subscribe. Please try again.' }),
        { status: 500, headers }
      );
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  },
};
```

- [ ] **Step 2: Start the local dev server**

```bash
cd worker && wrangler dev
```

Expected: `Ready on http://localhost:8787`

Leave this running. Open a second terminal for the next steps.

- [ ] **Step 3: Test — missing body returns 400**

```bash
curl -s -X POST http://localhost:8787/subscribe \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

Expected:
```json
{ "error": "Invalid email address" }
```

- [ ] **Step 4: Test — invalid email returns 400**

```bash
curl -s -X POST http://localhost:8787/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email": "notanemail"}' | jq .
```

Expected:
```json
{ "error": "Invalid email address" }
```

- [ ] **Step 5: Test — valid email with no API key returns 500**

```bash
curl -s -X POST http://localhost:8787/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}' | jq .
```

Expected: `{ "error": "Failed to subscribe. Please try again." }` (because `SENDGRID_API_KEY` is not set locally yet — this confirms the error path works correctly).

- [ ] **Step 6: Test — wrong method returns 405**

```bash
curl -s -X GET http://localhost:8787/subscribe | jq .
```

Expected:
```json
{ "error": "Method not allowed" }
```

- [ ] **Step 7: Stop wrangler dev (Ctrl+C), then commit**

```bash
cd .. && git add worker/index.js && git commit -m "feat: implement POST /subscribe Cloudflare Worker"
```

---

## Task 3: Deploy the Worker to Cloudflare

**Files:**
- No file changes — this task is deployment only

- [ ] **Step 1: Store the SendGrid API key as a secret**

```bash
cd worker && wrangler secret put SENDGRID_API_KEY
```

Wrangler will prompt: `Enter a secret value:` — paste your SendGrid API key and press Enter.

Expected: `✔ Success! Uploaded secret SENDGRID_API_KEY`

- [ ] **Step 2: Deploy the Worker**

```bash
wrangler deploy
```

Expected output includes a line like:
```
Published smudgetv-subscribe (X.XXs)
  https://smudgetv-subscribe.<your-account>.workers.dev
```

Copy that URL — you'll need it in Task 4.

- [ ] **Step 3: Smoke-test the live endpoint — invalid email**

Replace `<your-account>` with your actual Cloudflare account subdomain:

```bash
curl -s -X POST https://smudgetv-subscribe.<your-account>.workers.dev/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email": "bad"}' | jq .
```

Expected:
```json
{ "error": "Invalid email address" }
```

- [ ] **Step 4: Smoke-test the live endpoint — real email**

```bash
curl -s -X POST https://smudgetv-subscribe.<your-account>.workers.dev/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email": "test@smudgetv.com"}' | jq .
```

Expected:
```json
{ "success": true }
```

Then verify in SendGrid: Marketing → Contacts → your list → confirm `test@smudgetv.com` appears (may take 1–2 minutes for SendGrid to process).

---

## Task 4: Update index.html

**Files:**
- Modify: `index.html:119` — add `.form-error` CSS rule
- Modify: `index.html:537-565` — replace both `handleSubmit` functions and keyboard listeners

- [ ] **Step 1: Add error style to the CSS block**

Find line 119 in `index.html`:
```css
.success-msg { display: none; font-size: 1rem; color: var(--mint); margin-top: 16px; text-align: center; }
```

Add one line immediately after it:
```css
.form-error { font-size: 0.82rem; color: #f87171; margin-top: 8px; text-align: center; }
```

- [ ] **Step 2: Replace the entire script block (lines 537–565)**

Find this block in `index.html`:
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

Replace it entirely with (substitute your actual Worker URL from Task 3 Step 2):

```html
  <script>
    var WORKER_URL = 'https://smudgetv-subscribe.<your-account>.workers.dev/subscribe';

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

- [ ] **Step 3: Open index.html in a browser and test the hero form**

Open `index.html` directly in a browser (file:// is fine for this test since CORS is from the Worker's perspective — test with a real browser though, not just a curl).

Actually — since CORS is set to `smudgetv.com`, local `file://` testing will be blocked by the Worker. Use a simple local server instead:

```bash
cd /Users/junbarcellano/Projects/smudge_tv && python3 -m http.server 3000
```

Open `http://localhost:3000` in the browser.

**Test hero form:**
1. Type `hello` → click "Notify Me" → input should focus (client validation)
2. Type a real email → click "Notify Me" → button shows "Adding…" then returns to "Notify Me"
3. Success: green "You're on the list — we'll be in touch!" message appears, input clears

**Test bottom form:**
1. Scroll to the bottom "Join the Waitlist" section
2. Type a real email → click "Join the List" → same loading/success flow
3. Success: green message appears below the form row

**Test error state:**
To test error state, temporarily change `WORKER_URL` to a non-existent URL, submit, and confirm the red error message appears and the button re-enables. Then revert the URL.

- [ ] **Step 4: Stop the local server (Ctrl+C) and commit**

```bash
git add index.html && git commit -m "feat: replace mailto waitlist forms with Cloudflare Worker fetch"
```

- [ ] **Step 5: Push to remote**

```bash
git push origin feat/sendgrid-waitlist
```

---

## Post-deployment checklist

- [ ] Confirm signup appears in SendGrid Marketing → Contacts → your list (allow 1–2 min)
- [ ] Test from the live hosted site (not localhost) to verify CORS headers pass
- [ ] If the site moves to a custom domain other than `smudgetv.com`, update `ALLOWED_ORIGINS` in `worker/index.js` and redeploy
