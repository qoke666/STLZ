// файл: /api/_lib.js
// Файлы с "_" в начале имени Vercel НЕ превращает в отдельный роут —
// это просто общий код, который импортируют остальные /api-функции.

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Один клиент с service_role — обходит RLS, поэтому живёт только здесь,
// на сервере, и импортируется только из других /api-файлов.
export function getAdminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// Официальный алгоритм проверки initData от Telegram:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyTelegramInitData(initData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null; // подпись не сошлась — данные подделаны или устарели

  const userRaw = params.get('user');
  return userRaw ? JSON.parse(userRaw) : null; // { id, username, first_name, ... }
}

// Находит internal users.id по telegram id, либо создаёт профиль при первом заходе.
// ВАЖНО: это должно быть атомарно — если с фронта параллельно прилетело несколько
// запросов от одного и того же нового юзера (обычная ситуация при старте аппа,
// когда characters/trades/squad грузятся одновременно), find-затем-insert может
// создать ДВА разных users на одного человека. Поэтому застолбление identity идёт
// через upsert с опорой на unique(platform, platform_user_id) в БД, а не на
// предварительную проверку в JS — гонку разруливает сама база, а не наш код.
export async function getOrCreateUser(supabaseAdmin, tgUser) {
  const platformUserId = String(tgUser.id);

  // 1. быстрый путь — юзер уже точно существует
  const { data: existing } = await supabaseAdmin
    .from('platform_identities')
    .select('user_id')
    .eq('platform', 'telegram')
    .eq('platform_user_id', platformUserId)
    .maybeSingle();
  if (existing) return existing.user_id;

  // 2. создаём кандидата в users — если проиграем гонку, удалим его же ниже
  const { data: newUser, error: userErr } = await supabaseAdmin
    .from('users')
    .insert({ display_name: tgUser.username || tgUser.first_name || 'Игрок' })
    .select('id')
    .single();
  if (userErr) throw userErr;

  // 3. пытаемся застолбить identity — ignoreDuplicates значит "если кто-то параллельно
  //    уже занял этот platform_user_id, просто молча пропустить, не ошибаться"
  const { error: identErr } = await supabaseAdmin
    .from('platform_identities')
    .upsert(
      {
        user_id: newUser.id,
        platform: 'telegram',
        platform_user_id: platformUserId,
        platform_username: tgUser.username || null,
        verification_method: 'telegram_initdata',
        verified_at: new Date().toISOString(),
      },
      { onConflict: 'platform,platform_user_id', ignoreDuplicates: true }
    );
  if (identErr) throw identErr;

  // 4. источник правды — кто реально победил гонку (мы или параллельный запрос)
  const { data: final } = await supabaseAdmin
    .from('platform_identities')
    .select('user_id')
    .eq('platform', 'telegram')
    .eq('platform_user_id', platformUserId)
    .single();

  // проиграли — подчищаем свою пустышку в users, чтобы не плодить сирот
  if (final.user_id !== newUser.id) {
    await supabaseAdmin.from('users').delete().eq('id', newUser.id);
  }

  return final.user_id;
}

// Общий разбор входа: проверить initData → вернуть {supabaseAdmin, userId} или бросить 401.
export async function authenticate(req, res) {
  const tgUser = verifyTelegramInitData(req.body?.initData);
  if (!tgUser) {
    res.status(401).json({ error: 'invalid telegram initData' });
    return null;
  }
  const supabaseAdmin = getAdminClient();
  const userId = await getOrCreateUser(supabaseAdmin, tgUser);
  return { supabaseAdmin, userId, tgUser };
}

// Отправить уведомление конкретному users.id в его Telegram — но только если у него
// включена соответствующая галка в notification_preferences (prefKey — одно из полей
// этой таблицы, например 'notify_trade_request'). Тихо ничего не делает, если:
// - юзер выключил этот тип уведомлений,
// - у него нет привязанного Telegram (в теории может быть только VK),
// - сама отправка не удалась (не роняем основной запрос из-за упавшего уведомления).
export async function notifyUser(supabaseAdmin, userId, prefKey, text) {
  try {
    const { data: prefs } = await supabaseAdmin
      .from('notification_preferences')
      .select(prefKey)
      .eq('user_id', userId)
      .maybeSingle();
    // если строки настроек ещё нет вообще — считаем это дефолтом "включено" (см. схему)
    if (prefs && prefs[prefKey] === false) return;

    // В ленту внутри аппа падает независимо от того, есть ли у юзера Telegram —
    // это единственное место, где вообще можно узнать об уведомлении для VK-only
    // аккаунтов в будущем (сейчас такого не бывает, но лента уже готова к этому).
    await supabaseAdmin.from('notifications').insert({ user_id: userId, text: stripHtml(text) });

    const { data: identity } = await supabaseAdmin
      .from('platform_identities')
      .select('platform_user_id')
      .eq('user_id', userId)
      .eq('platform', 'telegram')
      .maybeSingle();
    if (!identity) return;

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: identity.platform_user_id, text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    console.error('notifyUser failed (не критично, продолжаем):', err);
  }
}

function stripHtml(text) {
  return text.replace(/<[^>]+>/g, '');
}
