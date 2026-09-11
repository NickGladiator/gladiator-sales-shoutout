import { postToSlack } from './lib/sales.mjs';
import { askSophia } from './lib/assistant.mjs';

// Background function — Netlify allows these up to 15 minutes, versus the ~10s a normal function
// gets. slack-event-handler.mjs hands off here and responds to Slack immediately, so the actual
// Claude + Housecall Pro work (which can easily take longer than 10s) has room to finish.
export default async (request) => {
  const { event } = await request.json();
  const question = event.text.replace(/<@[^>]+>\s*/, '').trim();

  try {
    const answer = await askSophia(question || 'How are we doing today?');
    try {
      await postToSlack(answer, event.thread_ts || event.ts);
    } catch {
      // Threaded post failed for some reason (bad ts, etc.) — better a plain message than nothing.
      await postToSlack(answer).catch(() => {});
    }
  } catch (err) {
    const msg = `Sorry, I ran into an error pulling that together: ${err.message}`;
    await postToSlack(msg, event.thread_ts || event.ts).catch(() => postToSlack(msg).catch(() => {}));
  }

  return new Response('OK', { status: 200 });
};

export const config = { background: true };
