// файл: /api/admin-add-guide.js
// POST { initData, title, meta, steps: [ { text, imageBase64?, imageMime? }, ... ] }
// Пускает только тебя — сверяет tgUser.id с ADMIN_TELEGRAM_ID из env.
// Если у шага есть imageBase64 — загружает картинку в Storage-бакет
// guide-images и сохраняет уже готовую публичную ссылку в базе.

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

  let processedSteps;
  try {
    // Загружаем картинки шагов, где они есть, параллельно
    processedSteps = await Promise.all(steps.map(async (step, idx) => {
      if (!step.text) throw new Error(`шаг ${idx + 1}: текст обязателен`);
      if (!step.imageBase64) return { text: step.text, imageUrl: null };

      const ext = (step.imageMime || 'image/jpeg').split('/')[1] || 'jpg';
      const path = `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const buffer = Buffer.from(step.imageBase64, 'base64');

      const { error: uploadErr } = await supabaseAdmin.storage
        .from('guide-images')
        .upload(path, buffer, { contentType: step.imageMime || 'image/jpeg' });
      if (uploadErr) throw uploadErr;

      const { data: pub } = supabaseAdmin.storage.from('guide-images').getPublicUrl(path);
      return { text: step.text, imageUrl: pub.publicUrl };
    }));
  } catch (err) {
    return res.status(400).json({ error: err.message || 'ошибка загрузки картинки' });
  }

  const { data, error } = await supabaseAdmin
    .from('guides')
    .insert({ title, meta: meta || null, steps: processedSteps, added_by: userId })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ guide: data });
}
