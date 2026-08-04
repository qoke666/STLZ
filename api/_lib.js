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
export async function getOrCreateUser(supabaseAdmin, tgUser) {
  const platformUserId = String(tgUser.id);

  const { data: existing } = await supabaseAdmin
    .from('platform_identities')
    .select('user_id')
    .eq('platform', 'telegram')
    .eq('platform_user_id', platformUserId)
    .maybeSingle();

  if (existing) return existing.user_id;

  const { data: newUser, error: userErr } = await supabaseAdmin
    .from('users')
    .insert({ display_name: tgUser.username || tgUser.first_name || 'Игрок' })
    .select('id')
    .single();
  if (userErr) throw userErr;

  await supabaseAdmin.from('platform_identities').insert({
    user_id: newUser.id,
    platform: 'telegram',
    platform_user_id: platformUserId,
    platform_username: tgUser.username || null,
    verification_method: 'telegram_initdata', // сама подпись initData И ЕСТЬ доказательство владения
    verified_at: new Date().toISOString(),
  });

  return newUser.id;
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
