// файл: /api/admin-add-promo.js
// POST { initData, code, expiresAt (ISO-строка или null) }
// Пускает только тебя — сверяет tgUser.id с ADMIN_TELEGRAM_ID из env.

import { authenticate } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, tgUser } = auth;

  if (String(tgUser.id) !== process.env.ADMIN_TELEGRAM_ID) {
    return res.status(403).json({ error: 'только администратор может добавлять промокоды' });
  }

  const { code, expiresAt } = req.body;
  if (!code) return res.status(400).json({ error: 'code обязателен' });

  const { data, error } = await supabaseAdmin
    .from('promo_codes')
    .insert({ code, expires_at: expiresAt || null })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'такой промокод уже есть' });
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ promo: data });
}
