import { localDateStr } from './lib/sales.mjs';

export default async () => {
  const today = localDateStr(new Date().toISOString(), 'America/Toronto');
  return new Response('pong2: ' + today, { status: 200 });
};
