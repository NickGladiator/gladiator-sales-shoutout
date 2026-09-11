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
    await postToSlack(answer);
  } catch (err) {
    const msg = `Sorry, I ran into an error pulling that together: ${err.message}`;
    await postToSlack(msg).catch(() => {});
  }

  return new Response('OK', { status: 200 });
};

export const config = { background: true };
