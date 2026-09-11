export default async () => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('testsecret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('hello'));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return new Response('pong4: ' + hex, { status: 200 });
};
