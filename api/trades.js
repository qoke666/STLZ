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

import { authenticate, notifyUser, checkRateLimit, getDisplayNickname, getUserTrustStats, isAdmin, tgSendMessage, tgEditMessage, resolveDispute, disputeMessageText, verdictKeyboard } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId, tgUser } = auth;
  const action = req.body.action;

  if (action === 'list') return handleList(supabaseAdmin, res);
  if (action === 'create') return handleCreate(supabaseAdmin, userId, req.body, res);
  if (action === 'respond') return handleRespond(supabaseAdmin, userId, req.body, res);
  if (action === 'confirm') return handleConfirm(supabaseAdmin, userId, req.body, res);
  if (action === 'my_deals') return handleMyDeals(supabaseAdmin, userId, res);
  if (action === 'dispute_respond') return handleDisputeRespond(supabaseAdmin, userId, req.body, res);
  if (action === 'admin_disputes') return handleAdminDisputes(supabaseAdmin, tgUser, res);
  if (action === 'admin_resolve') return handleAdminResolve(supabaseAdmin, tgUser, userId, req.body, res);

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
    .from('trade_deals').select('id, party_a, party_b, trade:trades(give_item, want_item)').eq('id', dealId).single();
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

    const { data: insertedDispute } = await supabaseAdmin.from('trade_disputes').insert({
      deal_id: dealId, reporter_id: userId,
      comment: comment || null, screenshot_url: screenshotUrl || null,
      admin_verdict: 'pending',
    }).select('id').single();
    await supabaseAdmin.from('trade_deals').update({ status: 'disputed', updated_at: new Date().toISOString() }).eq('id', dealId);

    await notifyUser(supabaseAdmin, counterpartyId, 'notify_trade_request',
      `⚠️ По вашей сделке открыт спор — вторая сторона отметила «не состоялась». Разбором займётся администратор.`);

    if (process.env.ADMIN_TELEGRAM_ID) {
      const text = disputeMessageText(dealId, deal.trade?.give_item, deal.trade?.want_item, false, comment);
      const sent = await tgSendMessage(process.env.ADMIN_TELEGRAM_ID, text, verdictKeyboard(dealId));
      if (sent?.result?.message_id && insertedDispute?.id) {
        await supabaseAdmin.from('trade_disputes').update({ admin_message_id: sent.result.message_id }).eq('id', insertedDispute.id);
      }
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
      confirmations:trade_confirmations(user_id, confirmed),
      dispute:trade_disputes(reporter_id, response_comment)
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
    const dispute = Array.isArray(d.dispute) ? d.dispute[d.dispute.length - 1] : d.dispute;

    return {
      id: d.id,
      status: d.status,
      giveItem: d.trade?.give_item,
      wantItem: d.trade?.want_item,
      counterpartyName,
      iAlreadyConfirmed: myConfirmation ? myConfirmation.confirmed : null,
      isReporter: dispute ? dispute.reporter_id === userId : null,
      hasResponded: dispute ? !!dispute.response_comment : null,
    };
  }));

  return res.status(200).json({ deals: withCounterparty });
}

async function handleDisputeRespond(supabaseAdmin, userId, body, res) {
  const { dealId, comment, screenshotUrl } = body;
  if (!dealId || !comment) return res.status(400).json({ error: 'dealId и comment обязательны' });

  const { data: deal } = await supabaseAdmin.from('trade_deals').select('party_a, party_b, status, trade:trades(give_item, want_item)').eq('id', dealId).single();
  if (!deal) return res.status(404).json({ error: 'сделка не найдена' });
  if (deal.party_a !== userId && deal.party_b !== userId) return res.status(403).json({ error: 'ты не участник этой сделки' });
  if (deal.status !== 'disputed') return res.status(400).json({ error: 'по этой сделке нет открытого спора' });

  const { data: dispute } = await supabaseAdmin.from('trade_disputes').select('id, reporter_id, comment, admin_message_id').eq('deal_id', dealId).order('created_at', { ascending: false }).limit(1).single();
  if (!dispute) return res.status(404).json({ error: 'спор не найден' });
  if (dispute.reporter_id === userId) return res.status(400).json({ error: 'у жалобщика уже есть свой комментарий — отвечать может только вторая сторона' });

  const { error } = await supabaseAdmin
    .from('trade_disputes')
    .update({ response_comment: comment, response_screenshot_url: screenshotUrl || null, responded_at: new Date().toISOString() })
    .eq('id', dispute.id);
  if (error) return res.status(500).json({ error: error.message });

  if (process.env.ADMIN_TELEGRAM_ID && dispute.admin_message_id) {
    const text = disputeMessageText(dealId, deal.trade?.give_item, deal.trade?.want_item, true, dispute.comment)
      + `\n\n💬 Ответ второй стороны: ${comment}`;
    await tgEditMessage(process.env.ADMIN_TELEGRAM_ID, dispute.admin_message_id, text, verdictKeyboard(dealId));
  }

  return res.status(200).json({ ok: true });
}

async function handleAdminDisputes(supabaseAdmin, tgUser, res) {
  if (!isAdmin(tgUser)) return res.status(403).json({ error: 'только администратор' });

  const { data: deals, error } = await supabaseAdmin
    .from('trade_deals')
    .select(`
      id, status, created_at, party_a, party_b,
      trade:trades(give_item, want_item),
      dispute:trade_disputes(comment, screenshot_url, admin_verdict, reporter_id, response_comment, response_screenshot_url, created_at)
    `)
    .eq('status', 'disputed')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // берём самый свежий спор по каждой сделке (на случай если было несколько отметок)
  const withContext = await Promise.all((deals || []).map(async (d) => {
    const dispute = Array.isArray(d.dispute) ? d.dispute[d.dispute.length - 1] : d.dispute;

    const [nameA, statsA, nameB, statsB] = await Promise.all([
      getDisplayNickname(supabaseAdmin, d.party_a),
      getUserTrustStats(supabaseAdmin, d.party_a),
      getDisplayNickname(supabaseAdmin, d.party_b),
      getUserTrustStats(supabaseAdmin, d.party_b),
    ]);

    // "вес" жалобы — не скрытая автоматика, а прозрачные цифры того, кто пожаловался,
    // чтобы ты сам мог оценить: свежий аккаунт с нулём сделок или давний трейдер
    const reporterStats = dispute?.reporter_id === d.party_a ? statsA : statsB;

    return {
      dealId: d.id,
      giveItem: d.trade?.give_item,
      wantItem: d.trade?.want_item,
      comment: dispute?.comment || null,
      screenshotUrl: dispute?.screenshot_url || null,
      responseComment: dispute?.response_comment || null,
      responseScreenshotUrl: dispute?.response_screenshot_url || null,
      alreadyResolved: dispute?.admin_verdict && dispute.admin_verdict !== 'pending',
      reporterIsPartyA: dispute?.reporter_id === d.party_a,
      reporterWeight: { days: reporterStats.days_in_app, completed: reporterStats.completed_trades, disputed: reporterStats.disputed_trades },
      partyA: { userId: d.party_a, nickname: nameA, days: statsA.days_in_app, completed: statsA.completed_trades, disputed: statsA.disputed_trades },
      partyB: { userId: d.party_b, nickname: nameB, days: statsB.days_in_app, completed: statsB.completed_trades, disputed: statsB.disputed_trades },
    };
  }));

  return res.status(200).json({ disputes: withContext });
}

async function handleAdminResolve(supabaseAdmin, tgUser, adminUserId, body, res) {
  if (!isAdmin(tgUser)) return res.status(403).json({ error: 'только администратор' });

  const { dealId, verdict } = body;
  if (!dealId || !verdict) return res.status(400).json({ error: 'dealId и verdict обязательны' });

  const result = await resolveDispute(supabaseAdmin, adminUserId, dealId, verdict);
  if (result.error) return res.status(400).json(result);

  // если у этого спора есть интерактивное сообщение в Telegram — убираем кнопки
  // и дописываем итог, чтобы не оставлять активные кнопки на уже решённом споре
  const { data: dispute } = await supabaseAdmin.from('trade_disputes').select('admin_message_id').eq('deal_id', dealId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (process.env.ADMIN_TELEGRAM_ID && dispute?.admin_message_id) {
    await tgEditMessage(process.env.ADMIN_TELEGRAM_ID, dispute.admin_message_id, `✅ <b>Решено</b>\n\n${result.verdictText}`, undefined);
  }

  return res.status(200).json({ ok: true, resolvedStatus: result.resolvedStatus });
}
