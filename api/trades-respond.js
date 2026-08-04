// файл: /api/trades-respond.js
// POST { initData, tradeId } → отклик на объявление, создаёт trade_deal между автором и откликнувшимся

import { authenticate } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;

  const { tradeId } = req.body;
  if (!tradeId) return res.status(400).json({ error: 'tradeId обязателен' });

  const { data: trade, error: tradeErr } = await supabaseAdmin
    .from('trades').select('id, creator_id, status').eq('id', tradeId).single();
  if (tradeErr || !trade) return res.status(404).json({ error: 'объявление не найдено' });
  if (trade.status !== 'open') return res.status(409).json({ error: 'объявление уже занято или закрыто' });
  if (trade.creator_id === userId) return res.status(400).json({ error: 'нельзя откликнуться на своё же объявление' });

  const { data: deal, error: dealErr } = await supabaseAdmin
    .from('trade_deals')
    .insert({ trade_id: trade.id, party_a: trade.creator_id, party_b: userId })
    .select('*')
    .single();
  if (dealErr) return res.status(500).json({ error: dealErr.message });

  await supabaseAdmin.from('trades').update({ status: 'agreed', updated_at: new Date().toISOString() }).eq('id', trade.id);

  return res.status(200).json({ deal });
}
