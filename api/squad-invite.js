// файл: /api/squad-invite.js
// POST { initData, listingId } → пригласить автора объявления в пачку

import { authenticate, notifyUser } from './_lib.js';

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

  // кому шлём — владельцу объявления (через character -> listing), не самому приглашающему
  const { data: listing } = await supabaseAdmin
    .from('squad_listings')
    .select('character:game_characters(user_id)')
    .eq('id', listingId)
    .single();

  if (listing?.character?.user_id) {
    // ник приглашающего + снаряжение из ЕГО собственного активного объявления (если есть)
    const { data: inviterChar } = await supabaseAdmin
      .from('game_characters').select('id, nickname').eq('user_id', userId).eq('is_primary', true).maybeSingle();

    let loadoutText = '';
    if (inviterChar) {
      const { data: inviterListing } = await supabaseAdmin
        .from('squad_listings').select('loadout')
        .eq('character_id', inviterChar.id)
        .eq('status', 'active')
        .maybeSingle();
      if (inviterListing?.loadout) loadoutText = ` Снаряжение: ${inviterListing.loadout}.`;
    }

    const nickname = inviterChar?.nickname || 'Игрок';

    await notifyUser(
      supabaseAdmin, listing.character.user_id, 'notify_squad_invite',
      `🎯 <b>${nickname}</b> зовёт тебя в пачку.${loadoutText} Открой STALZON, вкладка «Тиммейты».`
    );
  }

  return res.status(200).json({ invite: data });
}
