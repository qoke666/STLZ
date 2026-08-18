// файл: /api/trades-respond.js
// POST { initData, tradeId } → отклик на объявление, создаёт trade_deal между автором и откликнувшимся

import { authenticate, notifyUser, checkRateLimit } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;

  const { tradeId } = req.body;
  if (!tradeId) return res.status(400).json({ error: 'tradeId обязателен' });

  const allowed = await checkRateLimit(supabaseAdmin, userId, 'trade_respond', 10);
  if (!allowed) return res.status(429).json({ error: 'слишком часто — подожди немного' });

  const { data: trade, error: tradeErr } = await supabaseAdmin
    .from('trades').select('id, creator_id, give_item, want_item, status').eq('id', tradeId).single();
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

  const { data: responder } = await supabaseAdmin.from('users').select('display_name').eq('id', userId).single();
  await notifyUser(
    supabaseAdmin, trade.creator_id, 'notify_trade_request',
    `🔄 <b>${responder?.display_name || 'Игрок'}</b> откликнулся на твоё объявление: «${trade.give_item}» → «${trade.want_item}». Открой STALZON, вкладка «Обмен».`
  );

  return res.status(200).json({ deal });
}
