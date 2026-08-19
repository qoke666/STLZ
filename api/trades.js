// файл: /api/trades.js
// POST { initData, action:'list' }                                    → все открытые объявления
// POST { initData, action:'create', giveItem, wantItem }              → новое объявление
// POST { initData, action:'respond', tradeId }                        → отклик на объявление
// POST { initData, action:'confirm', dealId, confirmed, comment? }    → подтверждение/спор
// POST { initData, action:'my_deals' }                                → мои сделки, ждущие действия
//
// Объединено в один файл специально — у Vercel Hobby лимит в 12 serverless-функций
// на проект, а у нас их и так набиралось много; всё, что логически про "обмен",
// теперь живёт под одним роутом через action, а не разбросано по файлам.

import { authenticate, notifyUser, checkRateLimit, getDisplayNickname } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;
  const action = req.body.action;

  if (action === 'list') return handleList(supabaseAdmin, res);
  if (action === 'create') return handleCreate(supabaseAdmin, userId, req.body, res);
  if (action === 'respond') return handleRespond(supabaseAdmin, userId, req.body, res);
  if (action === 'confirm') return handleConfirm(supabaseAdmin, userId, req.body, res);
  if (action === 'my_deals') return handleMyDeals(supabaseAdmin, userId, res);

  return res.status(400).json({ error: 'unknown action' });
}

async function handleList(supabaseAdmin, res) {
  const { data, error } = await supabaseAdmin
    .from('trades')
    .select('id, short_code, give_item, want_item, status, created_at, creator:users!creator_id(id, display_name)')
    .eq('status', 'open')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ trades: data });
}

async function handleCreate(supabaseAdmin, userId, body, res) {
  const { giveItem, wantItem } = body;
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

async function handleRespond(supabaseAdmin, userId, body, res) {
  const { tradeId } = body;
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

  const nickname = await getDisplayNickname(supabaseAdmin, userId);
  await notifyUser(
    supabaseAdmin, trade.creator_id, 'notify_trade_request',
    `🔄 <b>${nickname}</b> откликнулся на твоё объявление: «${trade.give_item}» → «${trade.want_item}». Открой STALZON, вкладка «Обмен».`
  );

  return res.status(200).json({ deal });
}

async function handleConfirm(supabaseAdmin, userId, body, res) {
  const { dealId, confirmed, comment, screenshotUrl } = body;
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

  const { error: confErr } = await supabaseAdmin
    .from('trade_confirmations')
    .upsert({ deal_id: dealId, user_id: userId, confirmed }, { onConflict: 'deal_id,user_id' });
  if (confErr) return res.status(500).json({ error: confErr.message });

  if (!confirmed) {
    const allowed = await checkRateLimit(supabaseAdmin, userId, 'trade_dispute', 60);
    if (!allowed) return res.status(429).json({ error: 'слишком много споров подряд — подожди немного' });

    await supabaseAdmin.from('trade_disputes').insert({
      deal_id: dealId, reporter_id: userId,
      comment: comment || null, screenshot_url: screenshotUrl || null,
      admin_verdict: 'pending',
    });
    await supabaseAdmin.from('trade_deals').update({ status: 'disputed', updated_at: new Date().toISOString() }).eq('id', dealId);

    await notifyUser(supabaseAdmin, counterpartyId, 'notify_trade_request',
      `⚠️ По вашей сделке открыт спор — вторая сторона отметила «не состоялась». Разбором займётся администратор.`);
    if (process.env.ADMIN_TELEGRAM_ID) {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.ADMIN_TELEGRAM_ID, text: `🆘 Новый спор по сделке ${dealId}. Комментарий: ${comment || '—'}` }),
      }).catch(()=>{});
    }
    return res.status(200).json({ status: 'disputed' });
  }

  const { data: allConfirmations } = await supabaseAdmin
    .from('trade_confirmations').select('user_id, confirmed').eq('deal_id', dealId);

  const bothConfirmed = allConfirmations?.length === 2 && allConfirmations.every(c => c.confirmed);
  if (bothConfirmed) {
    await supabaseAdmin.from('trade_deals').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', dealId);
    await notifyUser(supabaseAdmin, counterpartyId, 'notify_trade_request', `✅ Сделка подтверждена обеими сторонами и закрыта.`);
    return res.status(200).json({ status: 'completed' });
  }

  return res.status(200).json({ status: 'awaiting_confirm' });
}

async function handleMyDeals(supabaseAdmin, userId, res) {
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

  const withCounterparty = await Promise.all((deals || []).map(async (d) => {
    const counterpartyId = d.party_a === userId ? d.party_b : d.party_a;
    const { data: char } = await supabaseAdmin
      .from('game_characters').select('nickname').eq('user_id', counterpartyId).eq('is_primary', true).maybeSingle();
    let counterpartyName = char?.nickname;
    if (!counterpartyName) {
      const { data: user } = await supabaseAdmin.from('users').select('display_name').eq('id', counterpartyId).single();
      counterpartyName = user?.display_name || 'Игрок';
    }
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
