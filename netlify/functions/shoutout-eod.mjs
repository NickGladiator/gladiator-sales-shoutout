import { runShoutout } from './lib/sales.mjs';

export default async () => {
  const result = await runShoutout({ label: 'End of Day Recap' });
  return new Response(JSON.stringify(result), { status: 200 });
};

// 6:00 PM Eastern. Same DST caveat as shoutout-midday.mjs — currently EDT (UTC-4), so 18:00 ET =
// 22:00 UTC. Once EST (UTC-5) kicks in, change this to "0 23 * * *".
export const config = { schedule: '0 22 * * *' };
