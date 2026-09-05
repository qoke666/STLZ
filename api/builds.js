// файл: /api/builds.js
// POST { initData, action:'list' }                                    → все сборки текущего юзера
// POST { initData, action:'create', name }                            → новая пустая сборка (лимит 5 на юзера)
// POST { initData, action:'update', buildId, patch:{...} }            → обновить любые поля сборки (частично)
// POST { initData, action:'delete', buildId }                         → удалить сборку

import { authenticate } from './_lib.js';

const MAX_BUILDS_PER_USER = 5;
const PATCHABLE_FIELDS = ['name', 'container_id', 'armor_id', 'weapon_id', 'ammo_id', 'attachments', 'artefacts', 'medicine'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;
  const action = req.body.action;

  if (action === 'list') return handleList(supabaseAdmin, userId, res);
  if (action === 'create') return handleCreate(supabaseAdmin, userId, req.body, res);
  if (action === 'update') return handleUpdate(supabaseAdmin, userId, req.body, res);
  if (action === 'delete') return handleDelete(supabaseAdmin, userId, req.body, res);

  return res.status(400).json({ error: 'unknown action' });
}

async function handleList(supabaseAdmin, userId, res) {
  const { data, error } = await supabaseAdmin
    .from('saved_builds')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ builds: data });
}

async function handleCreate(supabaseAdmin, userId, body, res) {
  const { count, error: countErr } = await supabaseAdmin
    .from('saved_builds').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  if (countErr) return res.status(500).json({ error: countErr.message });
  if (count >= MAX_BUILDS_PER_USER) {
    return res.status(409).json({ error: `можно сохранить не больше ${MAX_BUILDS_PER_USER} сборок — удали одну, чтобы создать новую` });
  }

  const name = (body.name || `Сборка ${count + 1}`).slice(0, 60);
  const { data, error } = await supabaseAdmin
    .from('saved_builds')
    .insert({ user_id: userId, name })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ build: data });
}

async function handleUpdate(supabaseAdmin, userId, body, res) {
  const { buildId, patch } = body;
  if (!buildId || !patch || typeof patch !== 'object') return res.status(400).json({ error: 'buildId и patch обязательны' });

  const { data: existing } = await supabaseAdmin.from('saved_builds').select('user_id').eq('id', buildId).single();
  if (!existing || existing.user_id !== userId) return res.status(403).json({ error: 'это не твоя сборка' });

  const cleanPatch = {};
  for (const key of PATCHABLE_FIELDS) if (key in patch) cleanPatch[key] = patch[key];
  if (Object.keys(cleanPatch).length === 0) return res.status(400).json({ error: 'нет допустимых полей для обновления' });
  cleanPatch.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('saved_builds').update(cleanPatch).eq('id', buildId).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ build: data });
}

async function handleDelete(supabaseAdmin, userId, body, res) {
  const { buildId } = body;
  if (!buildId) return res.status(400).json({ error: 'buildId обязателен' });

  const { data: existing } = await supabaseAdmin.from('saved_builds').select('user_id').eq('id', buildId).single();
  if (!existing || existing.user_id !== userId) return res.status(403).json({ error: 'это не твоя сборка' });

  const { error } = await supabaseAdmin.from('saved_builds').delete().eq('id', buildId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}
