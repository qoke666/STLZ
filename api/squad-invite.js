// файл: /api/squad-invite.js
// POST { initData, listingId } → пригласить автора объявления в пачку

import { authenticate } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;

  const { listingId } = req.body;
  if (!listingId) return res.status(400).json({ error: 'listingId обязателен' });

  const { data, error } = await supabaseAdmin
    .from('squad_invites')
    .insert({ listing_id: listingId, inviter_user_id: userId })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'ты уже приглашал этого игрока' });
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ invite: data });
}
