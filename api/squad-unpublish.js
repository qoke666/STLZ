// файл: /api/squad-unpublish.js
// POST { initData, listingId } → снимает объявление с публикации (status: 'closed')

import { authenticate } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;

  const { listingId } = req.body;
  if (!listingId) return res.status(400).json({ error: 'listingId обязателен' });

  // проверяем, что объявление реально принадлежит вызывающему
  const { data: listing } = await supabaseAdmin
    .from('squad_listings')
    .select('id, user_id')
    .eq('id', listingId)
    .single();

  if (!listing || listing.user_id !== userId) {
    return res.status(403).json({ error: 'это не твоё объявление' });
  }

  const { error } = await supabaseAdmin
    .from('squad_listings')
    .update({ status: 'closed' })
    .eq('id', listingId);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true });
}
