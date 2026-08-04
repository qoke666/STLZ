// файл: /api/admin-add-guide.js
// POST { initData, title, meta, steps: [ "шаг 1", "шаг 2", ... ] }
// Пускает только тебя — сверяет tgUser.id с ADMIN_TELEGRAM_ID из env.

import { authenticate } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId, tgUser } = auth;

  if (String(tgUser.id) !== process.env.ADMIN_TELEGRAM_ID) {
    return res.status(403).json({ error: 'только администратор может добавлять гайды' });
  }

  const { title, meta, steps } = req.body;
  if (!title || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'title и непустой массив steps обязательны' });
  }

  const { data, error } = await supabaseAdmin
    .from('guides')
    .insert({ title, meta: meta || null, steps, added_by: userId })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ guide: data });
}
