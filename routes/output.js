import express from 'express'
import { resolvePosUnitIds } from '../services/helperServices.js'
import { _notifySubmission } from '../services/notificationServices.js'
import { deleteOutputFile } from '../lib/uploadOutput.js'
import { selectAssigneeAssigner } from '../services/taskServices.js'
const router = express.Router()

// Requires testing
// >> Hexer <<
router.post('/insert', async (req, res) => {
    const { taskId, subtaskId, link } = req.body

    let query = { link }
    let selectQuery = null

    if (subtaskId) query.subtask_id = selectQuery = subtaskId
    else if (taskId) query.task_id = selectQuery = taskId
    else throw new Error('Please specify ID of a Task/Subtask')

    try {
        const { data: updated, error: updErr } = await req.supabase
            .from('task_output')
            .insert(query)
            .select()
        if (updErr) throw new Error(updErr.message)

        const taskRow = await selectAssigneeAssigner(req.supabase, selectQuery)
        const assigneeId = taskRow?.assignee || req.user.id
        const assignerId = taskRow?.assigner || req.user.id
        const isSelfAssigned = assigneeId === assignerId
        const { isOfficeMember } = await resolvePosUnitIds(req.supabase, assigneeId)

        let filter = req.supabase
            .from('task_approval')
            .update({ unit_head: true })

        filter = taskId
            ? filter.eq(idColumn, targetId)
            : filter.eq('subtask_id', subtaskId)

        if (isSelfAssigned || isOfficeMember) {
            const { error } = await filter
            if (error) throw new Error(`[Approval Update]: ${error.message}`);
        }
        await _notifySubmission(taskId, assigneeId, req.user.id, null, isSelfAssigned)

        return res.status(204)
    } catch (err) {
        console.log('Error submiting output: ', err.message)
        return res.status(500).json({ error: err.message })
    }
})

router.post('/update', async (req, res) => {
    const { taskId, subtaskId, newLink } = req.body

    const idColumn = subtaskId ? 'subtask_id' : 'task_id';
    const targetId = subtaskId || taskId;

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
            targetId,
            assigneeId,
            req.user.id,
            '📝 Submission updated — please review the new file.',
            isSelfAssigned
        )

    } catch (err) {
        console.log('Error updating output: ', err.message)
        return res.status(500).json({ error: err.message })
    }
})

router.post('/delete', async (req, res) => {
    const { taskId, subtaskId } = req.body

    const idColumn = subtaskId ? 'subtask_id' : 'task_id';
    const targetId = subtaskId || taskId;

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

            deleteOutputFile(currentLink).catch((e) => {
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

    } catch (err) {
        return res.status(500).json({ error: err.message })
    }

})

export default router