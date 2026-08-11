// файл: /api/admin-seed-items.js
// Разовый эндпоинт: открой в браузере ОДИН РАЗ
//   https://твой-домен.vercel.app/api/admin-seed-items?secret=ТВОЙ_SEED_SECRET
// и он сам скачает каталог предметов и зальёт в items_catalog.
// Защищён не через Telegram initData (тут его и не будет — это просто ссылка
// в браузере), а через отдельный секрет в query-параметре.

import { getAdminClient } from './_lib.js';

const LISTING_URL = 'https://raw.githubusercontent.com/EXBO-Studio/stalzone-database/main/global/listing.json';

export default async function handler(req, res) {
  if (req.query.secret !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: 'неверный secret' });
  }

  const supabaseAdmin = getAdminClient();

  const listingRes = await fetch(LISTING_URL);
  const raw = await listingRes.json();

  const rows = raw
    .filter(item => item.name?.lines?.ru)
    .map(item => ({
      id: item.data.split('/').pop().replace('.json', ''),
      name: item.name.lines.ru,
      rarity: item.color || 'DEFAULT',
      icon_url: item.icon
        ? `https://raw.githubusercontent.com/EXBO-Studio/stalzone-database/main/global${item.icon}`
        : null,
    }));

  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabaseAdmin.from('items_catalog').upsert(batch, { onConflict: 'id' });
    if (error) return res.status(500).json({ error: error.message, insertedBeforeFail: inserted });
    inserted += batch.length;
  }

  return res.status(200).json({ ok: true, totalSource: raw.length, inserted });
}
