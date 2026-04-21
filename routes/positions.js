import express from 'express'
import { fetchMemberPos } from '../services/memberServices.js'
const router = express.Router()

router.get('/fetch_pos', async (req, res) => {
    try {
        const { data: posRows, error: posErr } = await req.supabase
            .from('position_name')
            .select('id, pos_name')

        if (posErr) throw posErr

        return res.status(200).json({
            data: (posRows || [])
                .filter(p => p.name !== 'Admin')
                .map(p => ({
                    id: p.id,
                    name: p.pos_name
                }))
        })

    } catch (e) {
        console.log(`Error fetching positions: ${e}`)
        return res.status(500).json({ error: e.message })
    }
})

router.get('/fetch_roles', async (req, res) => {
    try {
        const { data, error } = await req.supabase.rpc('get_roles')
        if (error) throw error
        return res.status(200).json({ data })
    } catch (e) {
        console.log('Failed to fetch roles: ', e)
        return res.status(500).json({ error: e.message })
    }
})

router.get('/fetch_member_pos', async (req, res) => {
    try {
        const result = await fetchMemberPos(req.supabase)
        return res.status(200).json({ data: result })

    } catch (e) {
        console.log('Error: ', e)
        return res.status(500).json({ error: e.message })
    }
})

router.post('/change_roles', async(req, res) =>{
    const { userId, posId, unitId } = req.body
    try {
        const { data: updateRow, error: updateErr, status } = await req.supabase.rpc('promotion', {
            target_user_id: userId,
            target_pos_id:  posId,
            target_unit_id: unitId
        })

        if (updateErr) throw updateErr
        if (status === 200) {
            const result = await fetchMemberPos(req.supabase)
            return res.status(500).json({ data: result })
        }
    } catch (e) {
        console.log('Error: ', e)
        return res.status(500).json({ error: e.message })
    }
})

router.post('/add_user_pos', async(req, res) => {
    const { posId, unitId } = req.body
    try {
        const { error, status } = await req.supabase
            .from('position')
            .insert({ user_id: req.user.id, pos_id: posId, unit_id: unitId })

        if (error) throw error
        return res.status(status || 201)
    } catch (e) {
        console.log('Error adding position: ', e)
        return res.status(500).json({ error: e.message })
    }
})

router.post('/update_user_pos', async(req, res) => {
    const { posId, unitId, old_pos } = req.body
    try {
        const { error, status } = await req.supabase
                .from('position')
                .update({ pos_id: posId, unit_id: unitId })
                .eq('user_id', req.user.id)
                .eq('pos_id', old_pos)

            if (error) throw error
            return res.status(status || 201)
    } catch (e) {
        console.log('Error updating position: ', e)
        return res.status(500).json({ error: e.message })
    }
})

router.post('/delete_user_pos', async(req, res) => {
    const { posId } = req.body
    try {
        const { data, error, status } = await req.supabase
            .from('position')
            .delete()
            .eq('pos_id', posId)

        if (error) throw error
        return res.status(201 || status)
    } catch (e) {
        console.log('Error deleting position: ', e)
        return res.status(500).json({ error: e.message })
    }
})

// Units
router.get('/fetch_unit', async(req, res) => {
    try {
        const { data, error } = await req.supabase
            .from('unit_name')
            .select('*')

        if(error) throw error
        return res.status(200).json({ data })
    } catch(e) {
        console.log('Failed to fetch unit: ', e)
        return res.status(500).json({ error: e.message })
    }
})

router.get('/fetch_unit_peers', async(req, res) => {
    const { unitId } = req.query
    try {
        const { data, error } = await req.supabase.rpc('get_unit_position', { 
            target_unit_id: unitId 
          });

        if (error) throw error

        return res.status(200).json({data})
    } catch(e) {
        console.log('Error fetching peers: ', e)
        return res.status(500).json({ error: e.message })
    }
})

export default router