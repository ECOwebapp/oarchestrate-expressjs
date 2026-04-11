import express from 'express';
import { fetchUserData } from '../services/authServices.js'
const router = express.Router();

// Methods are better to be handled by PATCH instead of POST
// >> Hexer <<

router.post('/personal', async (req, res) => {
  const { payload, userId } = req.body
  const { avatar, address, ...profilePayload } = payload

  try {
    if (avatar && avatar.file.startsWith('data:')) {
      const matches = avatar.file.match(/^data:(.+);base64,(.+)$/);
      const contentType = matches[1];
      const buffer = Buffer.from(matches[2], 'base64');

      const { data, error } = await req.supabase.storage
        .from('avatars')
        .upload(avatar.path, buffer, {
          upsert: true,
          contentType: contentType,
        })

      if (error) {
        console.error('[avatar] Upload failed:', error.message, error)
        throw new Error(`Avatar upload failed: ${error.message}`)
      }

      const { data: urlData } = req.supabase.storage
        .from('avatars')
        .getPublicUrl(data.path)

      // Add timestamp to bust browser cache (same filename = stale cache)
      profilePayload.avatar_url = `${urlData.publicUrl}?t=${Date.now()}`
      console.log('[avatar] Public URL:', profilePayload.avatar_url)
    }

    if (address) {
      address.user_id = userId
      const { data: addRes, error: addErr, status } = await req.supabase
        .from('address')
        .upsert(address, { onConflict: 'user_id' })
        .select()

      if (addErr) console.log('Failed to upsert address: ', addErr.message)
      console.log('Update address status: ', status)
    }

    const { data: updateRes, error: updateErr, status } = await req.supabase
      .from('user_profile')
      .update(profilePayload)
      .eq('user_id', userId)
      .select()

    if (updateErr) console.log('Error updating profile: ', updateRes.message);

    const userData = await fetchUserData(req.supabase, userId)
    return res.status(status || 200).json({ userData: userData })
  } catch (e) {
    return res.status(401).json({ error: 'Error update: ', e })
  }
})

router.post('/contact', async (req, res) => {
  const { payload, userId } = req.body;
  const { email_address, phone } = payload;

  try {
    // We use a transaction-like approach: Clear old, add new
    // Note: Wrapping these in a Promise.all is faster
    const operations = [];

    if (Array.isArray(email_address)) {
      const emailRows = email_address.map(e => e.trim()).filter(Boolean)
        .map(email => ({ user_id: userId, email_address: email }));
      
      operations.push((async () => {
        await req.supabase.from('email').delete().eq('user_id', userId);
        if (emailRows.length) await req.supabase.from('email').insert(emailRows);
      })());
    }

    if (Array.isArray(phone)) {
      const phoneRows = phone.map(p => p.trim()).filter(Boolean)
        .map(num => ({ user_id: userId, phone: num }));

      operations.push((async () => {
        await req.supabase.from('contact').delete().eq('user_id', userId);
        if (phoneRows.length) await req.supabase.from('contact').insert(phoneRows);
      })());
    }

    await Promise.all(operations);
    const userData = await fetchUserData(req.supabase, userId)
    return res.status(200).json({ userData: userData })
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

export default router