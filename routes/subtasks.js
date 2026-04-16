import express from 'express'
import { SUBTASK_SELECT, subtaskRow } from '../services/taskServices.js'
const router = express.Router()

router.get('/fetch', async (req, res) => {
    const { parentId } = req.query
    const userId = req.user.id

    try {
        // 1. Get Requester Metadata
        const { data: requesterPos } = await req.supabase
            .from('position')
            .select('unit_id, pos_id')
            .eq('user_id', userId);

        const isDirector = requesterPos?.some(p => p.pos_id === 1);
        const headRole = requesterPos?.find(p => p.pos_id === 4);
        const activeUnitHeadId = headRole?.unit_id ?? null;

        let subtaskRows = [];

        // 2. Role-Based Fetching Logic
        if (isDirector) {
            // Director sees everything within parentId scope
            let query = req.supabase.from('subtask').select(SUBTASK_SELECT);
            if (parentId) query = query.eq('parent_task_id', Number(parentId));
            
            const { data, error } = await query.order('id', { ascending: false });
            if (error) throw error;
            subtaskRows = data || [];

        } else if (headRole) {
            // Unit Head Logic: The "Scenario B" Merge
            const { data: unitMembers } = await req.supabase
                .from('position')
                .select('user_id')
                .eq('unit_id', activeUnitHeadId);

            const allowedIds = [...new Set([userId, ...(unitMembers?.map(m => m.user_id) || [])])];

            // Parallel queries to handle the cross-table "OR" logic
            const [resDirect, resParent] = await Promise.all([
                req.supabase.from('subtask').select(SUBTASK_SELECT).in('assignee', allowedIds),
                req.supabase.from('subtask').select(SUBTASK_SELECT).in('task.assignee', allowedIds)
            ]);

            const combined = [...(resDirect.data || []), ...(resParent.data || [])];
            
            // Deduplicate and filter by parentId if provided
            subtaskRows = Array.from(new Map(combined.map(s => [s.id, s])).values());
            if (parentId) {
                subtaskRows = subtaskRows.filter(s => s.parent_task_id === Number(parentId));
            }
            
            subtaskRows.sort((a, b) => b.id - a.id);

        } else {
            // Regular Member Logic
            let query = req.supabase.from('subtask').select(SUBTASK_SELECT).eq('assignee', userId);
            if (parentId) query = query.eq('parent_task_id', Number(parentId));
            
            const { data, error } = await query.order('id', { ascending: false });
            if (error) throw error;
            subtaskRows = data || [];
        }

        // 3. Final Mapping
        // Pass the requester's ID to mapRow to handle 'isOwnTask' logic on the server
        const formattedTasks = subtaskRows.map(st => subtaskRow(st, activeUnitHeadId, userId))
        return res.status(200).json(formattedTasks);

    } catch (e) {
        return res.status(500).json({ error: e.message })
    }
})


export default router