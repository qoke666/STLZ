// файл: /api/admin-seed-items.js
// Разовый эндпоинт, дёргается прямо в браузере:
//   ?mode=basic (по умолчанию) — как раньше: название + редкость из listing.json
//   ?mode=stats — новое: полные характеристики оружия/брони/патронов из
//                 отдельных JSON-файлов репозитория, забранных ОДНИМ архивом
//                 (codeload tar.gz), а не тысячей отдельных запросов —
//                 это и не влезло бы в лимит времени функции, и было бы
//                 избыточной нагрузкой на GitHub.
// Защищён не через Telegram initData, а через отдельный секрет в query-параметре
// (это просто ссылка, которую открывают в браузере один раз, initData тут взять неоткуда).

import { getAdminClient } from './_lib.js';
import { gunzipSync } from 'zlib';

const LISTING_URL = 'https://raw.githubusercontent.com/EXBO-Studio/stalzone-database/main/global/listing.json';
const TARBALL_URL = 'https://codeload.github.com/EXBO-Studio/stalzone-database/tar.gz/refs/heads/main';

// Категории, для которых вообще имеет смысл считать боевые характеристики —
// остальное (контейнеры, рюкзаки, квестовые предметы и т.п.) нам не нужно.
const STAT_CATEGORIES = ['weapon', 'armor', 'bullet', 'attachment', 'weapon_modules'];

export default async function handler(req, res) {
  if (req.query.secret !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: 'неверный secret' });
  }

  const supabaseAdmin = getAdminClient();
  const mode = req.query.mode === 'stats' ? 'stats' : 'basic';

  if (mode === 'basic') return seedBasic(supabaseAdmin, res);
  return seedStats(supabaseAdmin, res);
}

async function seedBasic(supabaseAdmin, res) {
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

  return res.status(200).json({ ok: true, mode: 'basic', totalSource: raw.length, inserted });
}

async function seedStats(supabaseAdmin, res) {
  const tarRes = await fetch(TARBALL_URL);
  if (!tarRes.ok) return res.status(502).json({ error: 'не удалось скачать архив репозитория' });
  const gz = Buffer.from(await tarRes.arrayBuffer());
  const tarBuffer = gunzipSync(gz);

  const entries = parseTar(tarBuffer);
  const rows = [];

  for (const entry of entries) {
    // ищем строго global/<repo-name-с-хешем>/items/<категория>/.../<id>.json
    const m = entry.name.match(/\/global\/items\/([^/]+)\/.*\/([a-z0-9]+)\.json$/i)
           || entry.name.match(/\/global\/items\/([^/]+)\/([a-z0-9]+)\.json$/i);
    if (!m) continue;
    const [, category] = m;
    if (!STAT_CATEGORIES.includes(category)) continue;

    let json;
    try { json = JSON.parse(entry.content.toString('utf8')); } catch { continue; }
    if (!json.id) continue;

    const name = json.name?.lines?.ru;
    if (!name) continue; // без названия строку всё равно не вставить (name NOT NULL) — пропускаем как мусор

    rows.push({
      id: json.id,
      name,
      rarity: json.color || 'DEFAULT',
      category,
      stats: extractNumericStats(json),
    });
  }

  const BATCH = 300;
  let updated = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    // upsert по id — если базовая строка (название/редкость) уже есть, просто
    // дозаполняет category/stats; если вдруг предмета ещё нет — создаст с этими полями
    const { error } = await supabaseAdmin.from('items_catalog').upsert(batch, { onConflict: 'id' });
    if (error) return res.status(500).json({ error: error.message, updatedBeforeFail: updated });
    updated += batch.length;
  }

  return res.status(200).json({ ok: true, mode: 'stats', found: rows.length, updated });
}

// Обходит вложенные infoBlocks предмета и собирает все numeric-поля
// в плоский объект { "core.tooltip.info.weight": 2.71, ... } —
// имена ключей оставляем как в игре, чтобы не гадать со своим переводом.
function extractNumericStats(node, out = {}) {
  if (Array.isArray(node)) {
    for (const v of node) extractNumericStats(v, out);
  } else if (node && typeof node === 'object') {
    if (node.type === 'numeric' && node.name?.key && typeof node.value === 'number') {
      out[node.name.key] = node.value;
    }
    for (const v of Object.values(node)) extractNumericStats(v, out);
  }
  return out;
}

// Минимальный парсер tar (ustar) — без внешних зависимостей. GitHub codeload
// отдаёт стандартный tar.gz; нам нужны только обычные файлы (typeflag '0').
function parseTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break; // конец архива

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);

    offset += 512;
    if (typeFlag === '0' || typeFlag === '\0') {
      entries.push({ name, content: buffer.subarray(offset, offset + size) });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}
