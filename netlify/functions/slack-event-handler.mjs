// Note: this file intentionally does NOT import askSophia or postToSlack — the actual work
// happens in sophia-worker-background.mjs, which this file hands off to. Keeping this function
// fast and simple is what lets it respond to Slack within its time limit.
const SLACK_SIGNING_SECRET = (process.env.SLACK_SIGNING_SECRET || '').trim();

// Verifies the request really came from Slack. Uses the Web Crypto API (crypto.subtle) — a
// global, no import needed — rather than Node's built-in 'node:crypto' module, which we've
// confirmed breaks Netlify's function bundler detection entirely (HandlerNotFound errors).
async function verifySlackSignature(request, rawBody) {
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');
  if (!timestamp || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SLACK_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  const hex = [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
  const expected = `v0=${hex}`;

  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export default async (request) => {
  const rawBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad payload', { status: 400 });
  }

  // Slack's one-time handshake — handled before signature check since it's a single-use,
  // non-sensitive ping.
  if (payload.type === 'url_verification') {
    return new Response(payload.challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  if (!(await verifySlackSignature(request, rawBody))) {
    return new Response('Invalid signature', { status: 401 });
  }

  if (request.headers.get('x-slack-retry-num')) {
    return new Response('OK', { status: 200 });
  }

  if (payload.type === 'event_callback' && payload.event?.type === 'app_mention') {
    // Hand off to a background function rather than processing inline — the Claude + Housecall
    // Pro round trip can easily take longer than the ~10s a normal function gets before being
    // killed, which was silently swallowing the whole request with no reply ever posted.
    await fetch(`${new URL(request.url).origin}/.netlify/functions/sophia-worker-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: payload.event }),
    }).catch(() => { /* best effort — if this fails there's nothing more to do here */ });
  }

  return new Response('OK', { status: 200 });
};
