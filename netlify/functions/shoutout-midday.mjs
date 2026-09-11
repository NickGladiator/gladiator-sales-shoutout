import { runShoutout } from './lib/sales.mjs';

export default async () => {
  const result = await runShoutout({ label: 'Midday Check-In' });
  return new Response(JSON.stringify(result), { status: 200 });
};

// 12:00 PM Eastern. Netlify's scheduler runs on UTC, so this is a fixed offset, not a real
// timezone — it'll be an hour off once Daylight Saving ends in November. Currently EDT (UTC-4),
// so 12:00 ET = 16:00 UTC. Once EST (UTC-5) kicks in, change this to "0 17 * * *".
export const config = { schedule: '0 16 * * *' };
