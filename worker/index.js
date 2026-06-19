const ALLOWED_ORIGINS = ['https://smudgetv.com', 'https://www.smudgetv.com'];

function corsHeaders(origin) {
  if (!ALLOWED_ORIGINS.includes(origin)) return { 'Vary': 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
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
  for (const k of ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SES_FROM_EMAIL', 'SES_TO_EMAIL']) {
    if (!env[k]) throw new Error(`Missing env var: ${k}`);
  }
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

async function addToContactList(env, email) {
  for (const k of ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SES_CONTACT_LIST_NAME']) {
    if (!env[k]) throw new Error(`Missing env var: ${k}`);
  }

  const region = env.AWS_REGION;
  const service = 'ses';
  const host = `email.${region}.amazonaws.com`;
  const listName = encodeURIComponent(env.SES_CONTACT_LIST_NAME);
  const path = `/v2/email/contact-lists/${listName}/contacts`;

  const payload = JSON.stringify({ EmailAddress: email });

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

    let sesResponse;
    try {
      sesResponse = await sendSESEmail(env, email);
    } catch {
      return new Response(
        JSON.stringify({ error: 'Failed to subscribe. Please try again.' }),
        { status: 500, headers }
      );
    }

    if (!sesResponse.ok) {
      const errText = await sesResponse.text();
      console.error('SES error', sesResponse.status, errText);
      return new Response(
        JSON.stringify({ error: 'Failed to subscribe. Please try again.' }),
        { status: 500, headers }
      );
    }

    try {
      const listResponse = await addToContactList(env, email);
      if (!listResponse.ok) {
        const listErr = await listResponse.text();
        console.error('SES contact list error', listResponse.status, listErr);
      }
    } catch (e) {
      console.error('SES contact list exception', e.message);
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  },
};
