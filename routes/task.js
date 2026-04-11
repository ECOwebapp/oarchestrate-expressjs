import express from 'express';
import { supabase } from '../lib/supabaseClient.js'
const router = express.Router()

router.get('/', async (req, res) => {

    const TASK_SELECT = `
    id, parent_ppa_id, assigner, assignee, design,
    task_profile(title, description, urgent, revision, task_type,
      task_type_ref:task_type(task_type) ),
    task_approval( unit_head, director, revision_comment, revised_at ),
    task_duration( created, deadline ),
    task_output( link )
  `

    try{
        
    } catch(e) {
        res.status(500).json({ error: e.message })
    }
})

export default router