import { postToSlack } from './lib/sales.mjs';
import { askSophia } from './lib/assistant.mjs';

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
    const event = payload.event;
    const question = event.text.replace(/<@[^>]+>\s*/, '').trim();

    try {
      const answer = await askSophia(question || 'How are we doing today?');
      await postToSlack(answer, event.thread_ts || event.ts);
    } catch (err) {
      await postToSlack(`Sorry, I ran into an error pulling that together: ${err.message}`, event.thread_ts || event.ts)
        .catch(() => {});
    }
  }

  return new Response('OK', { status: 200 });
};
