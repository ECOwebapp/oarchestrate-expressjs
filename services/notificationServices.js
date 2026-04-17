import { resolvePosUnitIds } from "./helperServices.js"
import { columnResolver } from "./taskServices.js"

// ── NOTIFICATION HELPER ─────────────────────────────────────────────────────
export const _notifySubmission = async (
    supabase,
    taskId = null,
    subtaskId = null,
    assigneeId,
    fromUserId,
    message = null,
    isSelfAssigned = false
) => {
    const [
        { isOfficeMember, unitId },
        { directorId, allUnitHeads }
    ] = await Promise.all([
        await resolvePosUnitIds(supabase, assigneeId),
        await resolvePosUnitIds(supabase)
    ])

    const { idColumn, targetId } = columnResolver(taskId, subtaskId)

    if (isOfficeMember || isSelfAssigned) {
        if (directorId) {
            const { data: existing } = await supabase
                .from('task_revision')
                .select('id')
                .eq(idColumn, targetId)
                .eq('to_user', directorId)
                .eq('is_read', false)
                .maybeSingle()

            if (!existing) {
                await supabase.from('task_revision').insert({
                    [idColumn]: targetId,
                    from_user: fromUserId,
                    to_user: directorId,
                    role: 1, // directorId
                    comment: message || 'To directorId: Output submitted — awaiting your approval.',
                    is_read: false,
                })
            }
        }
        await supabase.from('task_notif').upsert(
            { [idColumn]: targetId, read_by_assignee: true, read_by_unit_head: true },
            { onConflict: targetId }
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
            const { data: existing } = await supabase
                .from('task_revision')
                .select('id')
                .eq(idColumn, targetId)
                .eq('to_user', uhId)
                .eq('is_read', false)
                .maybeSingle()

            console.log('I should\'ve been called once: ', uhId)

            if (!existing) {
                await supabase.from('task_revision').insert({
                    [idColumn]: targetId,
                    from_user: fromUserId,
                    to_user: uhId,
                    role: 4, // Unit Head
                    comment: message || 'From Unit Head: Output submitted — awaiting your review.',
                })
            } else if (!existing && isSenderAUnitHead) {
                await supabase.from('task_revision').insert({
                    [idColumn]: targetId,
                    from_user: fromUserId,
                    to_user: directorId,
                    role: 4,
                    comment: message || 'From Unit Head: Output submitted — awaiting your review.',
                })
            }
        }

        await supabase.from('task_notif').upsert(
            { [idColumn]: targetId, read_by_assignee: true },
            { onConflict: idColumn }
        )
    }
}