// Shared data for all Max Mart apps (customer, shop, owner, packer).
// Needs a D1 database bound to this Pages project as MMDB.
// Records: k = 'e' (orders/payments), 'p' (accounts), 'c' (catalog edits), 's' (staff).
// Every write bumps a global sequence; clients pull everything with ts > since.
const H = {
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...H, 'content-type': 'application/json' } });
const KINDS = new Set(['e', 'p', 'c', 's']);
let ready = false;

async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS rec (k TEXT NOT NULL, id TEXT NOT NULL, j TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (k, id))'),
    db.prepare('CREATE INDEX IF NOT EXISTS rec_ts ON rec (ts)'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, v INTEGER NOT NULL)'),
    db.prepare("INSERT OR IGNORE INTO meta (key, v) VALUES ('seq', 0), ('epoch', 1)"),
  ]);
  ready = true;
}

const bump = db => db.prepare("UPDATE meta SET v = v + 1 WHERE key = 'seq'");
const SEQ = "(SELECT v FROM meta WHERE key = 'seq')";

export async function onRequestOptions() {
  return new Response(null, { headers: H });
}

export async function onRequestGet({ request, env }) {
  const db = env.MMDB;
  if (!db) return json({ ok: false, error: 'no-db' }, 500);
  await init(db);
  const since = Number(new URL(request.url).searchParams.get('since') || 0);
  const [m, rows] = await db.batch([
    db.prepare("SELECT key, v FROM meta WHERE key IN ('seq', 'epoch')"),
    db.prepare('SELECT k, id, j, ts FROM rec WHERE ts > ? ORDER BY ts LIMIT 2000').bind(since),
  ]);
  const meta = Object.fromEntries(m.results.map(r => [r.key, r.v]));
  return json({ ok: true, seq: meta.seq, epoch: meta.epoch, rows: rows.results });
}

export async function onRequestPost({ request, env }) {
  const db = env.MMDB;
  if (!db) return json({ ok: false, error: 'no-db' }, 500);
  await init(db);
  let b = null;
  try { b = await request.json(); } catch (e) {}
  if (!b) return json({ ok: false }, 400);

  if (b.reset) {
    await db.batch([
      db.prepare('DELETE FROM rec'),
      db.prepare("UPDATE meta SET v = v + 1 WHERE key = 'epoch'"),
      bump(db),
    ]);
    const m = await db.prepare("SELECT v FROM meta WHERE key = 'epoch'").first();
    return json({ ok: true, epoch: m.v });
  }

  const ids = [];
  // New orders / payments: the server hands out the next number (#1001, #1002 …).
  for (const n of (Array.isArray(b.add) ? b.add : []).slice(0, 20)) {
    const j = JSON.stringify(n && n.j ? n.j : {});
    if (j.length > 60000) { ids.push(null); continue; }
    const [, r] = await db.batch([
      bump(db),
      db.prepare(`INSERT INTO rec (k, id, j, ts) SELECT 'e', CAST(COALESCE(MAX(CAST(id AS INTEGER)), 1000) + 1 AS TEXT), ?, ${SEQ} FROM rec WHERE k = 'e' RETURNING id`).bind(j),
    ]);
    ids.push(Number(r.results[0].id));
  }

  // Changes to existing records are merged field by field, so two phones
  // editing different parts of the same order don't overwrite each other.
  const st = [];
  for (const p of (Array.isArray(b.put) ? b.put : []).slice(0, 100)) {
    if (!p || !KINDS.has(p.k) || p.id == null) continue;
    const j = JSON.stringify(p.j || {});
    if (j.length > 400000) continue;
    st.push(bump(db));
    st.push(db.prepare(`INSERT INTO rec (k, id, j, ts) VALUES (?, ?, json_patch('{}', ?), ${SEQ})
      ON CONFLICT (k, id) DO UPDATE SET j = json_patch(rec.j, excluded.j), ts = excluded.ts`).bind(p.k, String(p.id), j));
  }
  if (st.length) await db.batch(st);
  return json({ ok: true, ids });
}
