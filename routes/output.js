import express from 'express'
import { resolvePosUnitIds } from '../services/helperServices.js'
import { _notifySubmission } from '../services/notificationServices.js'
import { deleteFile } from '../middleware/upload-to-drive.js'
import { selectAssigneeAssigner, fetchTasks, columnResolver } from '../services/taskServices.js'
const router = express.Router()

// Requires testing
// >> Hexer <<
router.post('/insert', async (req, res) => {
    const { taskId, subtaskId, link } = req.body
    const { idColumn, targetId } = columnResolver(taskId, subtaskId)

    try {
        const { data: outputRow, error: Err } = await req.supabase
            .from('task_output').select('id, link').eq(idColumn, targetId).maybeSingle()
        if(Err) throw new Error('[outputRow]: ', Err.message)

        let insertQuery = req.supabase.from('task_output')
        if(outputRow && outputRow.id && !outputRow.link) {
            insertQuery = insertQuery.update({ link: link }).eq('id', outputRow.id)
        } else {
            insertQuery = insertQuery.insert({ [idColumn]: targetId, link: link })
        }
        const { data: updated, error: updErr } = await insertQuery.select()
        if (updErr) throw new Error('[updErr]: ', updErr.message)

        const taskRow = await selectAssigneeAssigner(req.supabase, taskId, subtaskId)
        const assigneeId = taskRow?.assignee || req.user.id
        const assignerId = taskRow?.assigner || req.user.id
        const isSelfAssigned = assigneeId === assignerId
        const { isOfficeMember } = await resolvePosUnitIds(req.supabase, assigneeId)

        let filter = req.supabase
            .from('task_approval')
            .update({ unit_head: true })
            .eq(idColumn, targetId)

        if (isSelfAssigned || isOfficeMember) {
            const { error } = await filter
            if (error) throw new Error(`[Approval Update]: ${error.message}`);
        }
        await _notifySubmission(req.supabase, taskId, subtaskId, assigneeId, req.user.id, null, isSelfAssigned)

        if (taskId) {
            const formattedTasks = await fetchTasks(req.supabase, req.user.id, taskId)
            return res.status(200).json(formattedTasks)
        }
    } catch (err) {
        console.log('Error submiting output: ', err.message)
        return res.status(500).json({ error: err.message })
    }
})

router.post('/update', async (req, res) => {
    const { taskId, subtaskId, newLink } = req.body
    const { idColumn, targetId } = columnResolver(taskId, subtaskId)

    const selectQuery = req.supabase
        .from('task_output')
        .select('link')
        .eq(idColumn, targetId);

    const updateQuery = req.supabase // Ensure you use req.supabase for both
        .from('task_output')
        .update({ link: newLink })
        .eq(idColumn, targetId);

    try {
        const [
            { data: oldOutput, error: selectErr },
            { error: updErr }
        ] = await Promise.all([
            selectQuery.maybeSingle(),
            updateQuery
        ]);

        const oldLink = oldOutput?.link || null
        if (selectErr) throw new Error(selectErr.message)
        if (updErr) throw new Error(updErr.message)

        if (oldLink && oldLink !== newLink) {
            deleteOutputFile(oldLink).catch((e) => {
                console.warn('[editOutput] Could not delete old Drive file:', e.message)
                throw new Error(e.messae)
            })
        }

        // 4. Mark old pending notifications as read so a fresh one can go through
        await req.supabase
            .from('task_revision')
            .update({ is_read: true })
            .eq(idColumn, targetId)
            .eq('is_read', false)

        // 5. Re-notify the reviewer with the updated file
        const taskRow = await selectAssigneeAssigner(req.supabase, taskId ? taskId : subtaskId)
        const assigneeId = taskRow?.assignee || req.user.id
        const assignerId = taskRow?.assigner || req.user.id
        const isSelfAssigned = assigneeId === assignerId

        await _notifySubmission(
            req.supabase,
            taskId,
            subtaskId,
            assigneeId,
            req.user.id,
            '📝 Submission updated — please review the new file.',
            isSelfAssigned
        )
        if (taskId) {
            const formattedTasks = await fetchTasks(req.supabase, req.user.id, taskId)
            return res.status(200).json(formattedTasks)
        }

    } catch (err) {
        console.log('Error updating output: ', err.message)
        return res.status(500).json({ error: err.message })
    }
})

router.post('/delete', async (req, res) => {
    const { taskId, subtaskId } = req.body
    const { idColumn, targetId } = columnResolver(taskId, subtaskId)

    const selectQuery = req.supabase
        .from('task_output')
        .select('link')
        .eq(idColumn, targetId);

    const updateQuery = req.supabase // Ensure you use req.supabase for both
        .from('task_output')
        .update({ link: '' })
        .eq(idColumn, targetId)

    try {
        // 1. Grab the current link so we can delete it from Drive
        const { data: currentOutput } = await selectQuery.maybeSingle()
        const currentLink = currentOutput?.link || null

        // 3. Delete the Drive file (fire-and-forget)
        if (currentLink) {
            // 2. Clear the link in Supabase
            const { error: clearErr } = await updateQuery
            if (clearErr) throw new Error(clearErr.message)

            deleteFile(currentLink, res).catch((e) => {
                console.warn('[deleteOutput] Could not delete Drive file:', e.message)
                throw new Error(e.message)
            })
        }

        await Promise.all([
            // 4. Reset approval flags back to pre-submission state
            req.supabase
                .from('task_approval')
                .update({ unit_head: false, revision_comment: null, revised_at: null })
                .eq(idColumn, targetId),

            // 5. Dismiss pending reviewer notifications
            req.supabase
                .from('task_revision')
                .update({ is_read: true })
                .eq(idColumn, targetId)
                .eq('is_read', false),

            // 6. Defensive: clear revision flag
            req.supabase
                .from('task_profile')
                .update({ revision: false })
                .eq(idColumn, targetId)
        ])

        if (taskId) {
            const formattedTasks = await fetchTasks(req.supabase, req.user.id, taskId)
            return res.status(200).json(formattedTasks)
        }

    } catch (err) {
        return res.status(500).json({ error: err.message })
    }

})

export default router
