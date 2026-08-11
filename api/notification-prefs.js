// файл: /api/notification-prefs.js
// POST { initData, action:'get' }                          → текущие настройки (создаст дефолтные, если их ещё нет)
// POST { initData, action:'set', prefs:{...} }              → сохранить (частично, любые из 5 полей)

import { authenticate } from './_lib.js';

const FIELDS = ['notify_emission', 'notify_trade_request', 'notify_price_drop', 'notify_promo', 'notify_squad_invite'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;

  if (req.body.action === 'get') {
    const { data, error } = await supabaseAdmin
      .from('notification_preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });

    if (data) return res.status(200).json({ prefs: data });

    // ещё не заходил в настройки — создаём с дефолтами (см. схему) и возвращаем их
    const { data: created, error: createErr } = await supabaseAdmin
      .from('notification_preferences')
      .insert({ user_id: userId })
      .select('*')
      .single();
    if (createErr) return res.status(500).json({ error: createErr.message });
    return res.status(200).json({ prefs: created });
  }

  if (req.body.action === 'set') {
    const patch = {};
    for (const f of FIELDS) if (typeof req.body.prefs?.[f] === 'boolean') patch[f] = req.body.prefs[f];
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'нет валидных полей для обновления' });
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('notification_preferences')
      .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' })
      .select('*')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ prefs: data });
  }

  return res.status(400).json({ error: 'unknown action' });
}
