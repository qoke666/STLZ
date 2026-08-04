// файл: /api/characters.js
// POST { initData, action:'list' }               → список персонажей текущего юзера
// POST { initData, action:'create', nickname, faction, region, isPrimary } → добавить персонажа

import { authenticate } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });

  const auth = await authenticate(req, res);
  if (!auth) return; // authenticate уже отправил 401
  const { supabaseAdmin, userId } = auth;

  if (req.body.action === 'list') {
    const { data, error } = await supabaseAdmin
      .from('game_characters')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ characters: data });
  }

  if (req.body.action === 'create') {
    const { nickname, faction, region, isPrimary } = req.body;
    if (!nickname || !faction || !region) {
      return res.status(400).json({ error: 'nickname, faction и region обязательны' });
    }

    // если это первый персонаж — делаем его основным автоматически
    const { count } = await supabaseAdmin
      .from('game_characters')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    const shouldBePrimary = isPrimary || count === 0;

    if (shouldBePrimary) {
      // снимаем primary с остальных персонажей юзера — иначе упрётся в unique-индекс
      await supabaseAdmin.from('game_characters').update({ is_primary: false }).eq('user_id', userId);
    }

    const { data, error } = await supabaseAdmin
      .from('game_characters')
      .insert({ user_id: userId, nickname, faction, region, is_primary: shouldBePrimary })
      .select('*')
      .single();

    if (error) {
      // unique(region, nickname) — этот ник в этом регионе уже кем-то занят в приложении
      if (error.code === '23505') return res.status(409).json({ error: 'этот ник в этом регионе уже привязан другим аккаунтом' });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ character: data });
  }

  return res.status(400).json({ error: 'unknown action' });
}
