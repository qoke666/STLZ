// файл: /api/trades-confirm.js
// POST { initData, dealId, confirmed:true }                        → "обмен состоялся"
// POST { initData, dealId, confirmed:false, comment, screenshotUrl } → "не состоялся" → уходит в спор

import { authenticate, notifyUser } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;

  const { dealId, confirmed, comment, screenshotUrl } = req.body;
  if (!dealId || typeof confirmed !== 'boolean') {
    return res.status(400).json({ error: 'dealId и confirmed (true/false) обязательны' });
  }

  const { data: deal, error: dealErr } = await supabaseAdmin
    .from('trade_deals').select('id, party_a, party_b').eq('id', dealId).single();
  if (dealErr || !deal) return res.status(404).json({ error: 'сделка не найдена' });
  if (deal.party_a !== userId && deal.party_b !== userId) {
    return res.status(403).json({ error: 'ты не участник этой сделки' });
  }
  const counterpartyId = deal.party_a === userId ? deal.party_b : deal.party_a;

  // одна строка на пользователя — если уже подтверждал, апдейтим, не плодим дубли
  const { error: confErr } = await supabaseAdmin
    .from('trade_confirmations')
    .upsert({ deal_id: dealId, user_id: userId, confirmed }, { onConflict: 'deal_id,user_id' });
  if (confErr) return res.status(500).json({ error: confErr.message });

  if (!confirmed) {
    // "не состоялось" — сразу заводим спор, но статус сделки НЕ меняем в скам/бан автоматически,
    // окончательное слово за админом (см. trade_disputes.admin_verdict)
    await supabaseAdmin.from('trade_disputes').insert({
      deal_id: dealId, reporter_id: userId,
      comment: comment || null, screenshot_url: screenshotUrl || null,
      admin_verdict: 'pending',
    });
    await supabaseAdmin.from('trade_deals').update({ status: 'disputed', updated_at: new Date().toISOString() }).eq('id', dealId);

    await notifyUser(supabaseAdmin, counterpartyId, 'notify_trade_request',
      `⚠️ По вашей сделке открыт спор — вторая сторона отметила «не состоялась». Разбором займётся администратор.`);
    // администратора уведомляем напрямую, без проверки notification_preferences —
    // это его рабочий инструмент, а не опциональная рассылка
    if (process.env.ADMIN_TELEGRAM_ID) {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.ADMIN_TELEGRAM_ID, text: `🆘 Новый спор по сделке ${dealId}. Комментарий: ${comment || '—'}` }),
      }).catch(()=>{});
    }
    return res.status(200).json({ status: 'disputed' });
  }

  // проверяем, подтвердила ли уже и вторая сторона — тогда закрываем сделку целиком
  const { data: allConfirmations } = await supabaseAdmin
    .from('trade_confirmations').select('user_id, confirmed').eq('deal_id', dealId);

  const bothConfirmed = allConfirmations?.length === 2 && allConfirmations.every(c => c.confirmed);
  if (bothConfirmed) {
    await supabaseAdmin.from('trade_deals').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', dealId);
    await notifyUser(supabaseAdmin, counterpartyId, 'notify_trade_request', `✅ Сделка подтверждена обеими сторонами и закрыта.`);
    return res.status(200).json({ status: 'completed' });
  }

  return res.status(200).json({ status: 'awaiting_confirm' }); // ждём вторую сторону
}
