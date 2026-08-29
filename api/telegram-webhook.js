// файл: /api/telegram-webhook.js
// Telegram сам стучится сюда (POST), когда админ жмёт inline-кнопку под сообщением
// о споре. Это единственный эндпоинт, который принимает входящие данные ОТ Telegram,
// а не просто отправляет — раньше бот только слал сообщения, никогда не получал события.
//
// Настраивается ОДИН РАЗ, вручную, командой (замени TOKEN и DOMAIN):
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<DOMAIN>/api/telegram-webhook"
// Лучше выполнять из терминала, а не вставлять в браузер — там токен осядет в истории.

import { getAdminClient, getOrCreateUser, isAdmin, resolveDispute, tgAnswerCallback, tgEditMessage } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true }); // Telegram иногда пингует GET при настройке

  const update = req.body;
  const cb = update?.callback_query;
  if (!cb) return res.status(200).json({ ok: true }); // не кнопка — нам это не интересно, просто отвечаем 200

  const fromTelegram = cb.from; // { id, username, first_name, ... }
  const data = cb.data || '';   // формат: "v:<dealId>:<verdict>"
  const [, dealId, verdict] = data.split(':');

  if (!isAdmin(fromTelegram)) {
    await tgAnswerCallback(cb.id, 'Только администратор может выносить вердикт');
    return res.status(200).json({ ok: true });
  }

  const supabaseAdmin = getAdminClient();
  // у админа тоже есть свой users.id (создастся, если он ни разу не заходил в сам мини-апп) —
  // нужен, чтобы resolved_by указывал на реальную запись, а не на голый telegram id
  const adminUserId = await getOrCreateUser(supabaseAdmin, fromTelegram);

  const result = await resolveDispute(supabaseAdmin, adminUserId, dealId, verdict);

  if (result.error) {
    await tgAnswerCallback(cb.id, result.error);
    return res.status(200).json({ ok: true });
  }

  await tgAnswerCallback(cb.id, 'Вердикт вынесен');
  await tgEditMessage(
    cb.message.chat.id, cb.message.message_id,
    `✅ <b>Решено</b>\n\n${result.verdictText}`,
    undefined
  );

  return res.status(200).json({ ok: true });
}
