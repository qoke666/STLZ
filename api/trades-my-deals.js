// файл: /api/trades-my-deals.js
// POST { initData } → все сделки, где текущий юзер — party_a ИЛИ party_b,
// в статусах awaiting_confirm/disputed (то есть требующих внимания —
// закрытые completed/cancelled сюда не попадают, это не архив, а рабочий список).

import { authenticate } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;

  const { data: deals, error } = await supabaseAdmin
    .from('trade_deals')
    .select(`
      id, status, created_at,
      party_a, party_b,
      trade:trades(give_item, want_item),
      confirmations:trade_confirmations(user_id, confirmed)
    `)
    .or(`party_a.eq.${userId},party_b.eq.${userId}`)
    .in('status', ['awaiting_confirm', 'disputed'])
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // достаём ник второй стороны отдельно (по каждой сделке свой контрагент)
  const withCounterparty = await Promise.all((deals || []).map(async (d) => {
    const counterpartyId = d.party_a === userId ? d.party_b : d.party_a;
    const { data: char } = await supabaseAdmin
      .from('game_characters').select('nickname').eq('user_id', counterpartyId).eq('is_primary', true).maybeSingle();
    let counterpartyName = char?.nickname;
    if (!counterpartyName) {
      const { data: user } = await supabaseAdmin.from('users').select('display_name').eq('id', counterpartyId).single();
      counterpartyName = user?.display_name || 'Игрок';
    }

    // подтвердил ли уже Я сам эту сделку — фронту нужно, чтобы не показывать кнопки повторно
    const myConfirmation = d.confirmations?.find(c => c.user_id === userId);

    return {
      id: d.id,
      status: d.status,
      giveItem: d.trade?.give_item,
      wantItem: d.trade?.want_item,
      counterpartyName,
      iAlreadyConfirmed: myConfirmation ? myConfirmation.confirmed : null,
    };
  }));

  return res.status(200).json({ deals: withCounterparty });
}
