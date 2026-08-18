// файл: /api/trades.js
// POST { initData, action:'list' }  → все открытые объявления (публично можно и без этого файла,
//                                     через anon key напрямую, но так проще держать всё в одном месте)
// POST { initData, action:'create', giveItem, wantItem } → новое объявление

import { authenticate, checkRateLimit } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;

  if (req.body.action === 'list') {
    const { data, error } = await supabaseAdmin
      .from('trades')
      .select('id, short_code, give_item, want_item, status, created_at, creator:users!creator_id(id, display_name)')
      .eq('status', 'open')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ trades: data });
  }

  if (req.body.action === 'create') {
    const { giveItem, wantItem } = req.body;
    if (!giveItem || !wantItem) return res.status(400).json({ error: 'giveItem и wantItem обязательны' });

    const allowed = await checkRateLimit(supabaseAdmin, userId, 'trade_create', 30);
    if (!allowed) return res.status(429).json({ error: 'слишком часто — подожди немного перед новым объявлением' });

    const { data, error } = await supabaseAdmin
      .from('trades')
      .insert({ creator_id: userId, give_item: giveItem, want_item: wantItem })
      .select('*')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ trade: data });
  }

  return res.status(400).json({ error: 'unknown action' });
}
