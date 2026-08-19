// файл: /api/squad.js
// POST { initData, action:'list' }                                       → активные объявления (все, публично)
// POST { initData, action:'my' }                                          → СВОЁ активное объявление, если есть (или null)
// POST { initData, action:'create', characterId, loadout, goal }         → новое объявление (только если своего активного ещё нет)
// POST { initData, action:'invite', listingId }                          → пригласить автора объявления в пачку
// POST { initData, action:'unpublish', listingId }                       → снять своё объявление с публикации
//
// Объединено в один файл — у Vercel Hobby лимит в 12 serverless-функций на проект.

import { authenticate, notifyUser, checkRateLimit, getDisplayNickname } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;
  const action = req.body.action;

  if (action === 'list') return handleList(supabaseAdmin, res);
  if (action === 'my') return handleMy(supabaseAdmin, userId, res);
  if (action === 'create') return handleCreate(supabaseAdmin, userId, req.body, res);
  if (action === 'invite') return handleInvite(supabaseAdmin, userId, req.body, res);
  if (action === 'unpublish') return handleUnpublish(supabaseAdmin, userId, req.body, res);

  return res.status(400).json({ error: 'unknown action' });
}

async function handleList(supabaseAdmin, res) {
  const { data, error } = await supabaseAdmin
    .from('squad_listings')
    .select('id, loadout, goal, created_at, user_id, character:game_characters(nickname, faction, region)')
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ listings: data });
}

async function handleMy(supabaseAdmin, userId, res) {
  const existing = await findMyActiveListing(supabaseAdmin, userId);
  return res.status(200).json({ listing: existing });
}

async function handleCreate(supabaseAdmin, userId, body, res) {
  const { characterId, loadout, goal } = body;
  if (!characterId || !loadout) return res.status(400).json({ error: 'characterId и loadout обязательны' });

  const { data: character } = await supabaseAdmin
    .from('game_characters').select('id, user_id').eq('id', characterId).single();
  if (!character || character.user_id !== userId) {
    return res.status(403).json({ error: 'это не твой персонаж' });
  }

  const existing = await findMyActiveListing(supabaseAdmin, userId);
  if (existing) {
    return res.status(409).json({ error: 'у тебя уже есть активное объявление — сначала сними его с публикации' });
  }

  const allowed = await checkRateLimit(supabaseAdmin, userId, 'squad_create', 30);
  if (!allowed) return res.status(429).json({ error: 'слишком часто — подожди немного перед новым объявлением' });

  const { data, error } = await supabaseAdmin
    .from('squad_listings')
    .insert({ character_id: characterId, user_id: userId, loadout, goal: goal || null })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'у тебя уже есть активное объявление — сначала сними его с публикации' });
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ listing: data });
}

async function handleInvite(supabaseAdmin, userId, body, res) {
  const { listingId } = body;
  if (!listingId) return res.status(400).json({ error: 'listingId обязателен' });

  // нельзя пригласить самого себя — раньше этой проверки не было вообще
  const { data: listing } = await supabaseAdmin
    .from('squad_listings').select('user_id').eq('id', listingId).single();
  if (!listing) return res.status(404).json({ error: 'объявление не найдено' });
  if (listing.user_id === userId) {
    return res.status(400).json({ error: 'нельзя пригласить самого себя' });
  }

  const allowed = await checkRateLimit(supabaseAdmin, userId, 'squad_invite', 5);
  if (!allowed) return res.status(429).json({ error: 'слишком часто — подожди немного' });

  const { data, error } = await supabaseAdmin
    .from('squad_invites')
    .insert({ listing_id: listingId, inviter_user_id: userId })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'ты уже приглашал этого игрока' });
    return res.status(500).json({ error: error.message });
  }

  const { data: inviterChar } = await supabaseAdmin
    .from('game_characters').select('id, nickname').eq('user_id', userId).eq('is_primary', true).maybeSingle();

  let loadoutText = '';
  if (inviterChar) {
    const { data: inviterListing } = await supabaseAdmin
      .from('squad_listings').select('loadout')
      .eq('character_id', inviterChar.id)
      .eq('status', 'active')
      .maybeSingle();
    if (inviterListing?.loadout) loadoutText = ` Снаряжение: ${inviterListing.loadout}.`;
  }

  const nickname = inviterChar?.nickname || await getDisplayNickname(supabaseAdmin, userId);

  await notifyUser(
    supabaseAdmin, listing.user_id, 'notify_squad_invite',
    `🎯 <b>${nickname}</b> зовёт тебя в пачку.${loadoutText} Открой STALZON, вкладка «Тиммейты».`
  );

  return res.status(200).json({ invite: data });
}

async function handleUnpublish(supabaseAdmin, userId, body, res) {
  const { listingId } = body;
  if (!listingId) return res.status(400).json({ error: 'listingId обязателен' });

  const { data: listing } = await supabaseAdmin
    .from('squad_listings').select('id, user_id').eq('id', listingId).single();
  if (!listing || listing.user_id !== userId) {
    return res.status(403).json({ error: 'это не твоё объявление' });
  }

  const { error } = await supabaseAdmin
    .from('squad_listings').update({ status: 'closed' }).eq('id', listingId);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true });
}

async function findMyActiveListing(supabaseAdmin, userId) {
  const { data: existing } = await supabaseAdmin
    .from('squad_listings')
    .select('id, loadout, goal, created_at')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  return existing || null;
}
