export const taskRow = (t, activeUnitHeadId, userId) => {
    // Extract all pos_ids into an array: [11, 4]
    const roles = t.assignee_profile.positions?.map(r => r.pos_id) || [];
    const units = t.assignee_profile.positions?.map(r => r.unit_id) || [];

    // Logic from your resolveUnitIds
    const preferredUnit = (activeUnitHeadId && units.includes(activeUnitHeadId))
        ? activeUnitHeadId
        : (units[0] ?? null);

    return ({
        id: t.id,
        parentId: t.parent_ppa_id,
        assigner: t.assigner,
        assignee: t.assignee,
        assigneeName: `${t.assignee_profile?.fname} ${t.assignee_profile?.lname}`,
        assignerName: `${t.assigner_profile?.fname} ${t.assigner_profile?.lname}`,
        name: t.task_profile?.title || '',
        description: t.task_profile?.description || '',
        urgent: !!t.task_profile?.urgent,
        revision: !!t.task_profile?.revision,
        type: t.task_profile?.task_type_ref?.task_type || '',
        typeId: t.task_profile?.task_type || null,
        from: t.task_duration?.created || null,
        to: t.task_duration?.deadline || null,
        startDate: t.task_duration?.created || null,
        endDate: t.task_duration?.deadline || null,
        outputLink: t.task_output?.link ?? '',
        unitHead: !!t.task_approval?.unit_head,
        director: !!t.task_approval?.director,
        revisionComment: t.task_approval?.revision_comment || '',
        revisedAt: t.task_approval?.revised_at || null,
        overdue: (() => {
            const dl = t.task_duration?.deadline ? new Date(t.task_duration.deadline) : null
            if (!dl || t.task_approval?.director) return false
            dl.setHours(23, 59, 59, 999)
            return dl < new Date()
        })(),
        overdueDays: (() => {
            const dl = t.task_duration?.deadline ? new Date(t.task_duration.deadline) : null
            if (!dl || t.task_approval?.director) return 0
            dl.setHours(23, 59, 59, 999)
            const diff = new Date() - dl
            return diff > 0 ? Math.ceil(diff / 86400000) : 0
        })(),
        design: !!t.design,
        isSelfAssigned: t.assigner === t.assignee,
        assigneeRole: roles.includes(4) ? 4 : (roles.includes(1) ? 1 : (roles[0] || 11)),
        assigneeUnitId: preferredUnit,
        assigneeIsOffice: preferredUnit === 3,
        isOwnTask: t.assignee === userId,
    })
}

export const subtaskRow = (t, activeUnitHeadId, userId) => {
    // Extract all pos_ids into an array: [11, 4]
    const roles = t.assignee_profile.positions?.map(r => r.pos_id) || [];
    const units = t.assignee_profile.positions?.map(r => r.unit_id) || [];

    // Logic from your resolveUnitIds
    const preferredUnit = (activeUnitHeadId && units.includes(activeUnitHeadId))
        ? activeUnitHeadId
        : (units[0] ?? null);

    return ({
        id: t.id,
        parentId: t.parent_ppa_id,
        assigner: t.assigner,
        assignee: t.assignee,
        assigneeName: `${t.assignee_profile?.fname} ${t.assignee_profile?.lname}`,
        assignerName: `${t.assigner_profile?.fname} ${t.assigner_profile?.lname}`,
        name: t.task_profile?.title || '',
        description: t.task_profile?.description || '',
        urgent: !!t.task_profile?.urgent,
        revision: !!t.task_profile?.revision,
        type: t.task_profile?.task_type_ref?.task_type || '',
        typeId: t.task_profile?.task_type || null,
        from: t.task_duration?.created || null,
        to: t.task_duration?.deadline || null,
        startDate: t.task_duration?.created || null,
        endDate: t.task_duration?.deadline || null,
        outputLink: t.task_output?.link ?? '',
        unitHead: !!t.task_approval?.unit_head,
        director: !!t.task_approval?.director,
        revisionComment: t.task_approval?.revision_comment || '',
        revisedAt: t.task_approval?.revised_at || null,
        overdue: (() => {
            const dl = t.task_duration?.deadline ? new Date(t.task_duration.deadline) : null
            if (!dl || t.task_approval?.director) return false
            dl.setHours(23, 59, 59, 999)
            return dl < new Date()
        })(),
        overdueDays: (() => {
            const dl = t.task_duration?.deadline ? new Date(t.task_duration.deadline) : null
            if (!dl || t.task_approval?.director) return 0
            dl.setHours(23, 59, 59, 999)
            const diff = new Date() - dl
            return diff > 0 ? Math.ceil(diff / 86400000) : 0
        })(),
        design: !!t.design,
        designApproval: (t.design_approval || {}),
        isSelfAssigned: t.assigner === t.assignee,
        assigneeRole: roles.includes(4) ? 4 : (roles.includes(1) ? 1 : (roles[0] || 11)),
        assigneeUnitId: preferredUnit,
        assigneeIsOffice: preferredUnit === 3,
        isOwnTask: t.assignee === userId,
    })
}