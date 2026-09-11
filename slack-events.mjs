import { postToSlack } from './lib/sales.mjs';
import { askSophia } from './lib/assistant.mjs';
import { createHmac, timingSafeEqual } from 'node:crypto';

const SLACK_SIGNING_SECRET = (process.env.SLACK_SIGNING_SECRET || '').trim();

// Verifies the request really came from Slack (not a spoofed request hitting this public URL),
// per Slack's signing-secret scheme: https://api.slack.com/authentication/verifying-requests-from-slack
// Uses Node's built-in crypto module rather than the browser-style Web Crypto API (crypto.subtle) —
// that API's availability varies across Node versions in serverless environments, and a missing
// crypto.subtle would silently crash every request, including Slack's own verification check.
function verifySlackSignature(request, rawBody) {
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');
  if (!timestamp || !signature) return false;

  // Reject anything older than 5 minutes — replay-attack protection, per Slack's own guidance.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac('sha256', SLACK_SIGNING_SECRET).update(base).digest('hex');
  const expected = `v0=${hmac}`;

  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) return false;
  return timingSafeEqual(expectedBuf, signatureBuf);
}

export default async (request) => {
  const rawBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad payload', { status: 400 });
  }

  // Slack's one-time handshake when Event Subscriptions is first turned on — must echo the
  // challenge back verbatim, or Slack won't accept the URL. This is a single-use, non-sensitive
  // ping (it reveals nothing), so it's handled before the signature check below rather than
  // being blocked by it.
  if (payload.type === 'url_verification') {
    return new Response(payload.challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  if (!verifySlackSignature(request, rawBody)) {
    return new Response('Invalid signature', { status: 401 });
  }

  // Slack retries the same event if it doesn't get a fast-enough response, and Claude + Housecall
  // Pro calls can take longer than Slack's ~3s window — without this guard, a slow-but-successful
  // first attempt could still get a duplicate reply posted when Slack retries.
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
