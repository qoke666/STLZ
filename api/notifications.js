// файл: /api/notifications.js
// POST { initData, action:'list' }        → последние 30 уведомлений (новые сверху)
// POST { initData, action:'mark_read' }   → отметить все как прочитанные

import { authenticate } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { supabaseAdmin, userId } = auth;

  if (req.body.action === 'list') {
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .select('id, text, is_read, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ notifications: data });
  }

  if (req.body.action === 'mark_read') {
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'unknown action' });
}
