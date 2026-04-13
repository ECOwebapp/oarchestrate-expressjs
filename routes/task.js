import express from 'express';
import { taskRow } from '../services/taskServices.js';
const router = express.Router()

const TASK_SELECT = `
  id, parent_ppa_id, assigner, assignee, design,
  assignee_profile:user_profile!task_assignee_fkey1 (
    fname, 
    lname,
    positions:position(unit_id, pos_id)
  ),
  assigner_profile:user_profile!task_assigner_fkey1 (
    fname, 
    lname,
    positions:position(unit_id, pos_id)
  ),
  task_profile(title, description, urgent, revision, task_type,
    task_type_ref:task_type(task_type) ),
  task_approval( unit_head, director, revision_comment, revised_at ),
  task_duration( created, deadline ),
  task_output( link )
`

// Tasks that are children of a PPA
router.get('/fetch', async (req, res) => {
  const { parentId } = req.params

  try {
    const { data: requesterPos } = await req.supabase
      .from('position')
      .select('unit_id, pos_id')
      .eq('user_id', req.user.id);

    const isDirector = requesterPos?.some(p => p.pos_id === 1);
    const headRole = requesterPos?.find(p => p.pos_id === 4);
    const activeUnitHeadId = headRole?.unit_id ?? null;

    let query = req.supabase.from('task').select(TASK_SELECT)
    if (parentId) query = query.eq('parent_ppa_id', Number(parentId));

    if (!isDirector) {
      if (headRole) {
        // Unit Head: Sees their own tasks + anyone in their unit
        const { data: unitMembers } = await req.supabase
          .from('position')
          .select('user_id')
          .eq('unit_id', activeUnitHeadId);

        const allowedIds = [...new Set([req.user.id, ...(unitMembers?.map(m => m.user_id) || [])])];
        query = query.in('assignee', allowedIds);
      } else {
        // Regular Member: ONLY sees tasks assigned to them
        query = query.eq('assignee', req.user.id);
      }
    }

    const { data: tasks, error } = await query.order('id', { ascending: false });
    if (error) throw error

    const formattedTasks = tasks.map(t => taskRow(t, activeUnitHeadId, req.user.id));
    return res.status(200).json(formattedTasks);

  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

export default router