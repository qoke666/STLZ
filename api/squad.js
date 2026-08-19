// файл: /api/squad.js
// POST { initData, action:'list' }                                → активные объявления (все, публично)
// POST { initData, action:'my' }                                   → СВОЁ активное объявление, если есть (или null)
// POST { initData, action:'create', characterId, loadout, goal }  → новое объявление (только если своего активного ещё нет)

import { authenticate, checkRateLimit } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;

  if (req.body.action === 'list') {
    const { data, error } = await supabaseAdmin
      .from('squad_listings')
      .select('id, loadout, goal, created_at, character:game_characters(nickname, faction, region, user_id)')
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ listings: data });
  }

  if (req.body.action === 'my') {
    const existing = await findMyActiveListing(supabaseAdmin, userId);
    return res.status(200).json({ listing: existing });
  }

  if (req.body.action === 'create') {
    const { characterId, loadout, goal } = req.body;
    if (!characterId || !loadout) return res.status(400).json({ error: 'characterId и loadout обязательны' });

    // проверяем, что персонаж реально принадлежит тому, кто стучится
    const { data: character } = await supabaseAdmin
      .from('game_characters').select('id, user_id').eq('id', characterId).single();
    if (!character || character.user_id !== userId) {
      return res.status(403).json({ error: 'это не твой персонаж' });
    }

    // ограничение "одно активное объявление на пользователя" — проверяем по ВСЕМ
    // персонажам юзера, не только по этому конкретному, иначе можно обойти лимит,
    // просто переключившись на другого персонажа
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
      // на случай гонки — app-level проверка выше не абсолютная гарантия,
      // а вот constraint в базе (squad_listings_one_active_per_user) — да
      if (error.code === '23505') return res.status(409).json({ error: 'у тебя уже есть активное объявление — сначала сними его с публикации' });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ listing: data });
  }

  return res.status(400).json({ error: 'unknown action' });
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
