import express from 'express'
import { verifyToken } from '../middleware/verifyToken.js'
import { resolvePosUnitIds, resolvePosUnitNames } from '../services/helperServices.js'
import { resolveNames } from '../services/taskServices.js'
const router = express.Router()

const TOOU_ID = 3

router.get('/fetch', verifyToken, async (req, res) => {
    const uid = req.user.id
    if (!uid) return
    const results = []

    const { isDirector, isUnitHead } = await resolvePosUnitIds(req.supabase, uid, null)

    try {

        // ── 1. Registrations (director only) ────────────────
        // Schema: account_status.user_id → users
        //         user_profile.user_id   → users  (PK is user_id, NOT id)
        //         position.user_id, position.pos_id → position_name.id
        if (isDirector) {
            const { data: regs, error: regsErr } = await req.supabase
                .from('account_status')
                .select(`
            user_id,
            requested_at, 
            status_id (id, status), 
            notif_read_by_director
            `)
                .eq('status_id', 1)
                .order('requested_at', { ascending: false })
                .limit(20)

            if (regsErr) {
                console.error('[notifStore] account_status fetch error:', regsErr)
            }

            const userIds = (regs || []).map(r => r.user_id)

            const userMap = await resolvePosUnitNames(req.supabase, userIds)

            let nameMap = {}

            if (userIds.length) {
                const { profRes } = await req.supabase.from('user_profile')
                    .select('user_id, fname, middle_initial, lname')
                    .in('user_id', userIds)

                if (profRes.error) console.error('[notifStore] user_profile error:', profRes.error)

                nameMap = Object.fromEntries(
                    (profRes.data || []).map(p => [p.user_id, resolveNames({
                        fname: p.fname,
                        lname: p.lname,
                        middle_initial: p.middle_initial
                    })])
                )
            }

            (regs || []).forEach(r => {
                const { pos, unit } = userMap[r.user_id] || ''
                results.push({
                    id: `reg-${r.user_id}`,
                    type: 'registration',
                    userId: r.user_id,
                    title: nameMap[r.user_id] || 'New User',
                    position: pos || 'Unassigned',
                    unit: unit,
                    body: `Registered${unit ? ` under ${unit}` : ''} — awaiting your approval.`,
                    time: r.requested_at,
                    read: !!r.notif_read_by_director,
                    status: 'pending',
                })
            })
        }

        // ── 2. Task notifications ────────────────────────────
        // Build task query based on role:
        // Director   → tasks where unit_head=true and not yet director approved
        //              + Office unit tasks with output submitted
        // Unit Head  → tasks from their unit members with output submitted, not yet unit_head approved
        // Member     → their own tasks
        let taskRows = []
        let taskErr = null

        if (isDirector) {
            let officeFilter = null
            if (TOOU_ID) {
                const { data: om } = await req.supabase
                    .from('position').select('user_id').eq('unit_id', TOOU_ID)
                const officeIds = (om || []).map(m => m.user_id)
                if (officeIds.length) officeFilter = officeIds.map(id => `assignee.eq.${id}`).join(',')
            }

            const { data: d1, error: e1 } = await req.supabase
                .from('task')
                .select(`id, assignee, assigner,
            task_profile ( title, urgent, task_type_ref:task_type(task_type) ),
            task_approval ( unit_head, director ),
            task_duration ( created ),
            task_notif    ( read_by_assignee, read_by_director, read_by_unit_head ),
            task_output   ( link )`)
                .eq('task_approval.unit_head', true)
                .eq('task_approval.director', false)
                .limit(30)

            let d2 = []
            if (officeFilter) {
                const { data: od } = await req.supabase
                    .from('task')
                    .select(`id, assignee, assigner,
              task_profile!task_id ( title, urgent, task_type_ref:task_type(task_type) ),
              task_approval ( unit_head, director ),
              task_duration ( created ),
              task_notif    ( read_by_assignee, read_by_director, read_by_unit_head ),
              task_output   ( link )`)
                    .or(officeFilter)
                d2 = (od || []).filter(t => t.task_output?.link && !t.task_approval?.director)
            }
            const seen = new Set()
            taskRows = [...(d1 || []), ...d2].filter(t => {
                if (seen.has(t.id)) return false; seen.add(t.id); return true
            })
            taskErr = e1

        } else if (isUnitHead) {
            // Unit head: tasks from unit members with output submitted, not yet approved

            // So much for efficiency ehhh? Look what have you done Hexer.
            const { activeUnitId } = await resolvePosUnitIds(req.supabase, uid, null)
            const { unitMembers } = await resolvePosUnitIds(req.supabase, null, activeUnitId)


            const memberIds = (unitMembers || []).filter(id => id !== uid)

            if (memberIds.length) {
                const filter = memberIds.map(id => `assignee.eq.${id}`).join(',')
                const { data: d, error: e } = await req.supabase
                    .from('task')
                    .select(`id, assignee, assigner,
              task_profile ( title, urgent, task_type_ref:task_type(task_type) ),
              task_approval ( unit_head, director ),
              task_duration ( created ),
              task_notif    ( read_by_assignee, read_by_director, read_by_unit_head ),
              task_output   ( link )`)
                    .or(filter).limit(30)
                taskRows = (d || []).filter(t => t.task_output?.link && !t.task_approval?.unit_head)
                taskErr = e
            }

        } else {
            const { data: d, error: e } = await req.supabase
                .from('task')
                .select(`id, assignee, assigner,
            task_profile ( title, urgent, task_type_ref:task_type(task_type) ),
            task_approval ( unit_head, director ),
            task_duration ( created ),
            task_notif    ( read_by_assignee, read_by_director, read_by_unit_head )`)
                .or(`assignee.eq.${uid},assigner.eq.${uid}`)
                .limit(30)
            taskRows = d || []
            taskErr = e
        }

        if (taskErr) console.error('[notifStore] task fetch error:', taskErr)

        const uids2 = [...new Set((taskRows || [])
            .flatMap(t => [t.assigner, t.assignee]).filter(Boolean))]
        let nm2 = {}
        if (uids2.length) {
            const { data: p2 } = await req.supabase
                .from('user_profile').select('user_id, fname, lname').in('user_id', uids2)
            nm2 = Object.fromEntries(
                (p2 || []).map(p => [p.user_id, resolveNames({ fname: p.fname, lname: p.lname }).trim()])
            )
        }

        (taskRows || []).forEach(t => {
            const urgent = !!t.task_profile?.urgent
            const taskType = t.task_profile?.task_type_ref?.task_type?.toLowerCase() || 'regular'
            let isRead = false
            if (isDirector) isRead = !!t.task_notif?.read_by_director
            else if (isUnitHead) isRead = !!t.task_notif?.read_by_unit_head
            else isRead = !!t.task_notif?.read_by_assignee

            // For members: only show their own pending tasks
            if (!isDirector && !isUnitHead) {
                if (t.assignee !== uid) return
            }

            const submitter = nm2[t.assignee] || 'Someone'
            const assigner = nm2[t.assigner] || 'Unknown'
            results.push({
                id: `task-${t.id}`,
                type: 'task_submitted',
                title: t.task_profile?.title || 'Untitled Task',
                body: isUnitHead
                    ? `${submitter} submitted output — awaiting your review · ${taskType}${urgent ? ' · URGENT' : ''}`
                    : isDirector
                        ? `${submitter} · ${taskType}${urgent ? ' · URGENT' : ''} · approved by Unit Head`
                        : `Assigned by ${assigner} · ${taskType}${urgent ? ' · URGENT' : ''}`,
                time: t.task_duration?.created,
                read: isRead,
                meta: { urgent, taskType, taskId: t.id },
            })
        })

        // ── 3. Pokes ─────────────────────────────────────────
        const { data: pokes, error: pokeErr } = await req.supabase
            .from('task_poke')
            .select(`
          id, task_id, from_user, message, created_at, is_read,
          task:task_poke_task_id_fkey ( task_profile(title) )
        `)
            .eq('to_user', uid)
            .order('created_at', { ascending: false })
            .limit(20)

        if (pokeErr) console.error('[notifStore] task_poke error:', pokeErr)

        const pokerIds = [...new Set((pokes || []).map(p => p.from_user).filter(Boolean))]
        let pokerMap = {}
        if (pokerIds.length) {
            const { data: pp } = await req.supabase
                .from('user_profile')
                .select('user_id, fname, lname')
                .in('user_id', pokerIds)
            pokerMap = Object.fromEntries(
                (pp || []).map(p => [p.user_id, `${p.fname || ''} ${p.lname || ''}`.trim()])
            )
        }

        ; (pokes || []).forEach(p => {
            results.push({
                id: `poke-${p.id}`,
                type: 'poke',
                title: pokerMap[p.from_user] || 'A team member',
                body: p.message || `Followed up on "${p.task?.task_profile?.title || 'a task'}"`,
                time: p.created_at,
                read: !!p.is_read,
                meta: { taskId: p.task_id },
            })
        })

        results.sort((a, b) => new Date(b.time) - new Date(a.time))
        return res.status(200).json({ data: results })

    } catch (e) {
        console.error('[notifStore] fetchNotifs error:', e)
        return res.status(500).json({ error: e.message })
    }
})

router.post('/mark_all_as_read', verifyToken, async (req, res) => {
    const { taskIds, pokeIds } = req.body
    const { isDirector, isUnitHead } = await resolvePosUnitIds(req.supabase, req.user.id, null)
    try {
        // Do NOT mass-mark registrations as read here —
        // they are individually marked read only when approved/denied
        let query = []
        if (taskIds.length) {
            const col = isDirector
                ? 'read_by_director'
                : isUnitHead
                    ? 'read_by_unit_head'
                    : 'read_by_assignee'
            query.push(req.supabase.from('task_notif').update({ [col]: true }).in('task_id', taskIds))
        }
        if (pokeIds.length) {
            query.push(req.supabase.from('task_poke').update({ is_read: true }).in('id', pokeIds))
        }

        const [taskNotif, taskPoke] = await Promise.all(query)
        if (taskNotif.error) throw taskNotif.error
        if (taskPoke.error) throw taskPoke.error

        return res.status(201)
    } catch (e) {
        console.error('[notifStore] markAllRead error:', e)
        return res.status(500).json({ error: e.message })
    }
})

// Keep track of connected clients
let clients = [];

// Endpoint for the Vue frontend to connect
router.get('/events', verifyToken, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Add this client to our list
    clients.push(res);

    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

// Endpoint for your Supabase Webhook
router.post('/webhook', (req, res) => {
    const notification = req.body;

    // Broadcast to all connected clients
    clients.forEach(client => {
        client.write(`data: ${JSON.stringify(notification)}\n\n`);
    });

    res.status(200).send('Event relayed');
});

export default router