// Packing-done notifications: the packer's page POSTs here, the owner app polls with GET.
// Needs a KV namespace bound to this Pages project as MM.
const clean = (s, n) => String(s == null ? '' : s).slice(0, n);
const chan = s => clean(s, 40).replace(/[^a-z0-9]/gi, '');

export async function onRequestPost({ request, env }) {
  if (!env.MM) return Response.json({ ok: false, error: 'no-kv' }, { status: 500 });
  let b = null;
  try { b = await request.json(); } catch (e) {}
  const ch = b && chan(b.ch);
  if (!ch || !b.i) return Response.json({ ok: false }, { status: 400 });
  const rec = { i: Number(b.i) || 0, n: clean(b.n, 40), c: clean(b.c, 60), d: Number(b.d) || 0, t: Number(b.t) || 0, at: Date.now() };
  await env.MM.put(`pk:${ch}:${rec.at}:${rec.i}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 7 });
  return Response.json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const ch = chan(u.searchParams.get('ch'));
  const since = Number(u.searchParams.get('since') || 0);
  if (!env.MM || !ch) return Response.json([], { headers: { 'cache-control': 'no-store' } });
  const list = await env.MM.list({ prefix: `pk:${ch}:` });
  const out = [];
  for (const k of list.keys) {
    const at = Number(k.name.split(':')[2]);
    if (at > since) { const v = await env.MM.get(k.name); if (v) out.push(JSON.parse(v)); }
  }
  return Response.json(out, { headers: { 'cache-control': 'no-store' } });
}
