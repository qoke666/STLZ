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

  // Рассылка всем, у кого включены уведомления о промокодах (или кто вообще
  // не заходил в настройки — дефолт "включено", см. schema-migration-6).
  // ВАЖНО: ждём завершения (не fire-and-forget) — Vercel может заморозить функцию
  // сразу после отправки ответа, и незавершённый цикл рассылки просто оборвётся.
  // Для маленького сообщества это ок в одном запросе; при сильном росте базы
  // стоит перейти на очередь вместо цикла в одной функции.
  await broadcastPromo(supabaseAdmin, code).catch(err => console.error('broadcastPromo failed:', err));

  return res.status(200).json({ promo: data });
}

async function broadcastPromo(supabaseAdmin, code) {
  const { data: identities } = await supabaseAdmin
    .from('platform_identities').select('user_id, platform_user_id').eq('platform', 'telegram');
  if (!identities?.length) return;

  const { data: prefs } = await supabaseAdmin
    .from('notification_preferences').select('user_id, notify_promo');
  const optedOut = new Set((prefs || []).filter(p => p.notify_promo === false).map(p => p.user_id));

  const recipients = identities.filter(i => !optedOut.has(i.user_id));
  const text = `🎁 Новый промокод: <code>${code}</code>\nОткрой STALZON, вкладка «Промокоды», чтобы скопировать.`;

  await Promise.all(recipients.map(r =>
    fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: r.platform_user_id, text, parse_mode: 'HTML' }),
    }).catch(()=>{})
  ));
}
