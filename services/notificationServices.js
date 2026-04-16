import { resolvePosUnitIds } from "./helperServices.js"

// ── NOTIFICATION HELPER ─────────────────────────────────────────────────────
export const _notifySubmission = async (req, taskId, assigneeId, fromUserId, message = null, isSelfAssigned = false) => {
    const [
        { isOfficeMember, unitId },
        { directorId, allUnitHeads }
    ] = await Promise.all([
        await resolvePosUnitIds(req.supabase, assigneeId),
        await resolvePosUnitIds(req.supabase)
    ])

    if (isOfficeMember || isSelfAssigned) {
        if (directorId) {
            const { data: existing } = await req.supabase
                .from('task_revision')
                .select('id')
                .eq('task_id', taskId)
                .eq('to_user', directorId)
                .eq('is_read', false)
                .maybeSingle()

            if (!existing) {
                await req.supabase.from('task_revision').insert({
                    task_id: taskId,
                    from_user: fromUserId,
                    to_user: directorId,
                    role: 1, // directorId
                    comment: message || 'To directorId: Output submitted — awaiting your approval.',
                    is_read: false,
                })
            }
        }
        await req.supabase.from('task_notif').upsert(
            { task_id: taskId, read_by_assignee: true, read_by_unit_head: true },
            { onConflict: 'task_id' }
        )
    } else {
        const uhIds = [...new Set((
            allUnitHeads
                .filter(r => r.unit_id === unitId)
                .map(r => r.user_id)
            || []))]

        // 2. Check if the current sender is in that list
        const isSenderAUnitHead = allUnitHeads
            .map(link => link.user_id)
            .includes(fromUserId)

        for (const uhId of uhIds) {
            const { data: existing } = await req.supabase
                .from('task_revision')
                .select('id')
                .eq('task_id', taskId)
                .eq('to_user', uhId)
                .eq('is_read', false)
                .maybeSingle()

            console.log('I should\'ve been called once: ', uhId)

            if (!existing) {
                await req.supabase.from('task_revision').insert({
                    task_id: taskId,
                    from_user: fromUserId,
                    to_user: uhId,
                    role: 4, // Unit Head
                    comment: message || 'From Unit Head: Output submitted — awaiting your review.',
                })
            } else if (!existing && isSenderAUnitHead) {
                await req.supabase.from('task_revision').insert({
                    task_id: taskId,
                    from_user: fromUserId,
                    to_user: directorId,
                    role: 4,
                    comment: message || 'From Unit Head: Output submitted — awaiting your review.',
                })
            }
        }

        await req.supabase.from('task_notif').upsert(
            { task_id: taskId, read_by_assignee: true },
            { onConflict: 'task_id' }
        )
    }
}