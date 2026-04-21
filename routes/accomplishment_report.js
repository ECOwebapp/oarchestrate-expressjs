import express from 'express'
import { resolvePosUnitIds } from '../services/helperServices.js'
import { resolveNames } from '../services/taskServices.js'
const router = express.Router()

router.get('/load_all_tasks', async (req, res) => {
    const { isDirector, isUnitHead } = await resolvePosUnitIds(req.supabase, req.user.id, null)
    // 1. Fetch user-to-unit memberships from the same source used by the rest of the app.
    const { data: unitRows, error: unitRowsError } = await req.supabase
        .from('position')
        .select('user_id, unit_id, unit_name!position_unit_id_fkey(name)')
        .not('unit_id', 'is', null)
        .order('unit_id')

    if (unitRowsError) {
        console.error('[AccomplishmentReport] position_of_members:', unitRowsError.message)
        return res.status(500).json({ error: unitRowsError.message })
    }

    if (!unitRows || !unitRows.length) { return res.status(400).json({ error: 'No unit found' }) }

    // 2. Build unit_id → unit name map, and unit_id → [user_ids]
    const unitNameMap = {}
    const unitMemberMap = {}
    for (const row of unitRows) {
        const uid = row.unit_id
        const name = row.unit_name || `Unit ${uid}`
        if (!unitNameMap[uid]) unitNameMap[uid] = name
        if (!unitMemberMap[uid]) unitMemberMap[uid] = []
        if (row.user_id) unitMemberMap[uid].push(row.user_id)
    }

    // Build reverse map: user_id -> [unit_id,...] to support multi-unit memberships.
    const userUnitMap = {}
    for (const row of unitRows) {
        if (!row.user_id || row.unit_id == null) continue
        if (!userUnitMap[row.user_id]) userUnitMap[row.user_id] = []
        userUnitMap[row.user_id].push(row.unit_id)
    }

    // If not director, restrict to own unit only
    const allowedUnitIds = isDirector
        ? Object.keys(unitMemberMap).map(Number)
        : currentUserUnitId.value ? [currentUserUnitId.value] : []

    const allMemberIds = [...new Set([
        ...allowedUnitIds.flatMap(uid => unitMemberMap[uid] || []),
        req.user.id,
    ].filter(Boolean))]
    if (!allMemberIds.length) { return res.status(400).json({ error: 'Unit Members not found' }) }

    // 3. Fetch tasks for those members
    const { data, error: taskError } = await req.supabase
        .from('task')
        .select(`
        id, parent_id, assignee,
        task_profile ( title, task_type_ref:task_type(task_type) ),
        task_approval ( unit_head, director, revision_comment ),
        task_duration ( created, deadline ),
        task_output   ( link )
      `)
        .is('parent_id', null)
        .in('assignee', allMemberIds)
        .order('id')

    if (taskError) {
        console.error('[AccomplishmentReport] task:', taskError.message)
        return res.status(500).json({ error: taskError.message })
    }

    if (!data || !data.length) { return res.status(400).json({ error: 'No task found' }) }

    const parentTaskIds = data.map(t => t.id).filter(Boolean)
    const subtaskMap = {}
    if (parentTaskIds.length) {
        const { data: subtasksData, error: subtasksError } = await req.supabase
            .from('task')
            .select('id, parent_id, task_profile ( title )')
            .in('parent_id', parentTaskIds)
            .order('id')

        if (subtasksError) {
            console.error('[AccomplishmentReport] subtasks:', subtasksError.message)
            return res.status(500).json({ error: subtasksError.message })
        }

        ; (subtasksData || []).forEach((s) => {
            const pid = s.parent_id
            if (!pid) return
            if (!subtaskMap[pid]) subtaskMap[pid] = []
            subtaskMap[pid].push(s)
        })
    }

    const statusOf = (t) => {
        if (t.task_approval?.director) return 'Approved'
        if (t.task_approval?.revision_comment) return 'Revision'
        if (t.task_output?.link) return 'Submitted'
        return 'Pending'
    }

    // 5. Resolve names
    const uids = [...new Set(data.map(t => t.assignee).filter(Boolean))]
    const nameMap = {}
    if (uids.length) {
        const { data: profiles, error: profilesError } = await req.supabase
            .from('user_profile').select('user_id, fname, lname').in('user_id', uids)

        if (profilesError) {
            console.error('[AccomplishmentReport] user_profile:', profilesError.message)
        }

        ; (profiles || []).forEach(p => {
            nameMap[p.user_id] = `${p.fname || ''} ${p.lname || ''}`.trim()
        })
    }

    const FMT = { month: 'short', day: 'numeric', year: 'numeric' }
    const fmt = (s) => { const d = new Date(s); return isNaN(d) ? '—' : d.toLocaleDateString('en-PH', FMT) }
    const durDays = (s, e) => {
        const sd = new Date(s), ed = new Date(e)
        return (isNaN(sd) || isNaN(ed)) ? '—' : Math.max(1, Math.ceil((ed - sd) / 86400000))
    }
    const progressOf = (t) => {
        if (t.task_approval?.director) return 100
        if (t.task_approval?.unit_head) return 75
        if (t.task_output?.link) return 50
        return 25
    }

    // 6. Map rows
    const mapped = data.map(t => {
        const assigneeUnits = userUnitMap[t.assignee] || []
        const resolvedUnitId = assigneeUnits.find(uid =>
            allowedUnitIds.includes(Number(uid))
        ) ?? assigneeUnits[0] ?? null

        return {
            id: t.id,
            unitId: resolvedUnitId,
            ppa: '',
            name: t.task_profile?.title || '',
            type: t.task_profile?.task_type_ref?.task_type || 'General',
            assignee: t.assignee,
            assigneeName: nameMap[t.assignee] || '—',
            startDate: fmt(t.task_duration?.created),
            endDate: fmt(t.task_duration?.deadline),
            duration: durDays(t.task_duration?.created, t.task_duration?.deadline),
            progress: progressOf(t),
            subtaskNames: (subtaskMap[t.id] || []).map(s => s.task_profile?.title || '').filter(Boolean),
            mov: t.task_output?.link ? { label: 'View Output', url: t.task_output.link } : null,
            remarks: statusOf(t),
            rawStart: t.task_duration?.created || null,
            rawEnd: t.task_duration?.deadline || null,
        }
    })

    // 7. Group by unit → then by task title (merge multiple assignees into one row)
    const unitTaskMap = {}
    for (const uid of allowedUnitIds) {
        unitTaskMap[uid] = {}
    }
    for (const t of mapped) {
        const uid = t.unitId
        if (!unitTaskMap[uid]) continue
        const key = `${t.name || '(Untitled)'}::${t.remarks}`
        if (!unitTaskMap[uid][key]) {
            unitTaskMap[uid][key] = { ...t, assignedTo: [] }
        }
        unitTaskMap[uid][key].assignedTo.push(t.assigneeName)
    }

    return res.status(200).json({
        data: allowedUnitIds
            .map(uid => ({
                unitId: uid,
                unitName: unitNameMap[uid] || `Unit ${uid}`,
                tasks: Object.values(unitTaskMap[uid] || {}),
            }))
            .filter(g => g.tasks.length > 0)
    })
})

router.get('/load_own_tasks', async (req, res) => {
    const { data, error } = await req.supabase
        .from('task')
        .select(`
      id, assignee,
      task_profile ( title, description, task_type_ref:task_type(task_type) ),
      task_approval ( unit_head, director, revision_comment ),
      task_duration ( created, deadline ),
      task_output   ( link )
    `)
        .is('parent_id', null)
        .eq('assignee', uid)

    if (error) {
        console.error('[IndividualAccomplishmentReport] task:', error.message)
        return res.status(500).json({ error: error.message })
    }

    const parentTaskIds = (data || []).map(t => t.id).filter(Boolean)
    const subtaskMap = {}
    if (parentTaskIds.length) {
        const { data: subtasksData, error: subtasksError } = await req.supabase
            .from('task')
            .select('id, parent_id, task_profile ( title, description )')
            .in('parent_id', parentTaskIds)
            .order('id')

        if (subtasksError) {
            console.error('[IndividualAccomplishmentReport] subtasks:', subtasksError.message)
            return res.status(500).json({ error: subtasksError.message })
        }

        ; (subtasksData || []).forEach((s) => {
            const pid = s.parent_id
            if (!pid) return
            if (!subtaskMap[pid]) subtaskMap[pid] = []
            subtaskMap[pid].push(s)
        })
    }

    return res.status(200).json({
        data: (data || []).map(t => ({
            assignee: t.assignee,
            name: t.task_profile?.title || '',
            description: t.task_profile?.description || '',
            type: t.task_profile?.task_type_ref?.task_type || '',
            unitHead: !!t.task_approval?.unit_head,
            director: !!t.task_approval?.director,
            startDate: t.task_duration?.created || null,
            endDate: t.task_duration?.deadline || null,
            outputLink: t.task_output?.link || null,
            subtaskNames: (subtaskMap[t.id] || []).map(s => s.task_profile?.title || '').filter(Boolean),
        }))
    })
})

router.get('/load_unit_head', async (req, res) => {
    const { unitId } = req.query
    try {
        // Query position_of_members where unit_id matches and pos_id = 4 (Unit Head)
        const { data: headRows, error } = await req.supabase
            .from('position')
            .select('user_id')
            .eq('unit_id', unitId)
            .eq('pos_id', 4)
            .limit(1)

        if (error || !headRows?.length) {
            return res.status(404).json({ error: 'Unit Head not found' })
        }

        const headUserId = headRows[0].user_id

        // Fetch the head's profile
        const { data: profile, error: profileError } = await req.supabase
            .from('user_profile')
            .select('fname, lname, middle_initial')
            .eq('user_id', headUserId)
            .single()

        if (profileError || !profile) {
            return res.status(404).json({ error: 'Unit Head not found' })
        }

        return res.status(200).json({
            data: resolveNames(profile).trim().toUpperCase()
        })

    } catch (err) {
        console.log('Failed to fetch Unit Head: ', err.message)
        return res.status(500).json({ error: err.message })
    }
})

export default router