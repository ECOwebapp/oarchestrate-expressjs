import express from 'express'
import { fetchMembers } from '../services/memberServices'
const router = express.Router()

// Address
router.get('/fetch_address', async (req, res) => {
    const { userId } = req.query
    try {
        let query = req.supabase
            .from('address')
            .select('*')
        if (userId) query = query.eq('user_id', userId).maybeSingle()

        const { data, error } = await query
        if (error) throw new Error(error)

        return res.status(200).json({ data })
    } catch (e) {
        console.log('Failed to fetch address: ', e)
        return res.status(500).json({ error: e.message })
    }
})

// Contact
router.get('/contact', async (req, res) => {
    // 1 for email, 2 for phone number
    const { type } = req.query
    try {
        if (type === 1) {
            const { data, error } = await req.supabase
                .from('email')
                .select('user_id, email_address')

            if (error) throw error

            return res.status(200).json({ emails: data })

        } else if (type === 2) {
            const { data, error } = await req.supabase
                .from('contact')
                .select('user_id, phone')

            if (error) throw error
            return res.status(200).json({ phone_numbers: data })
        }
        else return res.status(400).send('Please provide an instance type.')
    } catch (e) {
        console.log('Error fetching contact: ', e)
        return res.status(500).json({ error: e.message })
    }
})

// Genders
router.get('/fetch_genders', async (req, res) => {
    try {
        const { data, error } = await req.supabase
            .from('gender_type')
            .select('id, gender')
            .order('id')

        if (error) throw error

        return res.status(200).json({
            gender: (data || [])
                .map(g => ({
                    id: g.id,
                    type: g.gender
                }))
        })

    } catch (e) {
        console.log('Error fetching gender: ', e)
        return res.status(500).json({ error: e.message })
    }
})

// Member management
router.get('/fetch_members', async (req, res) => {
    try {
        const result = await fetchMembers(req.supabase)
        return res.status(200).json({ members: result })
    } catch (err) {
        console.log('Failed to fetch members: ', e)
        return res.status(500).json({ error: err.message })
    }
})

router.post('/remove_members', async (req, res) => {
    const { userId } = req.body
    try {
        const { error, status } = await req.supabase.functions.invoke('delete-user', {
            body: { userId }
        })

        if (error) throw error
        if (status === 200) {
            const result = await fetchMembers(req.supabase)
            return res.status(200).json({ members: result })
        }
    } catch (e) {
        console.log('Error removing: ', e)
        return res.status(500).json({ error: err.message })
    }
})

router.post('/approve_user', async (req, res) => {
    const { userId } = req.body
    try {
        const { error } = await req.supabase
            .from('account_status')
            .update({
                status_id: 2,
                notif_read_by_director: true,
                reviewed_by: req.user?.id,
                reviewed_at: new Date().toISOString(),
            })
            .eq('user_id', userId)
        if (error) throw error
        return res.status(201)
    } catch (e) {
        console.error('[notifStore] approveUser error:', e)
        return res.status(500).json({ error: err.message })
    }
})

router.post('/deny_user', async (req, res) => {
    const { userId } = req.body
    try {
        const { error } = await req.supabase
            .from('account_status')
            .update({
                status_id: 3,
                notif_read_by_director: true,
                reviewed_by: req.user?.id,
                reviewed_at: new Date().toISOString(),
            })
            .eq('user_id', userId)
        if (error) throw error
        return res.status(201)
    } catch (e) {
        console.error('[notifStore] denyUser error:', e)
        return res.status(500).json({ error: err.message })
    }
})

export default router