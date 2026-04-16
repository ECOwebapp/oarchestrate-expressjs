export const resolveNames = (user) => {
    if (!user) return null
    return `${user.fname} ${user.middle_initial} ${user.lname}`
}

export const TASK_SELECT = `
    id, parent_ppa_id, assigner, assignee, design,
    assignee_profile:user_profile!task_assignee_fkey1 (
    fname, 
    lname,
    positions:position(unit_id, pos_id)
    ),
    assigner_profile:user_profile!task_assigner_fkey1 (
    fname,
    middle_initial, 
    lname,
    positions:position(unit_id, pos_id)
    ),
    task_profile(title, description, urgent, revision, task_type,
    task_type_ref:task_type(task_type) ),
    task_approval( unit_head, director, revision_comment, revised_at ),
    task_duration( created, deadline ),
    task_output( link )
`

export const SUBTASK_SELECT = `
    id, parent_task_id, parent_subtask_id, assigner, assignee, design,
    assignee_profile:user_profile!subtask_assignee_fkey (
    fname, 
    lname,
    positions:position(unit_id, pos_id)
    ),
    assigner_profile:user_profile!subtask_assigner_fkey (
    fname, 
    lname,
    positions:position(unit_id, pos_id)
    ),
    task_profile!subtask_id ( title, description, urgent, revision, task_type,
    task_type_ref:task_type(task_type) ),
    task_approval!subtask_id ( unit_head, director, revision_comment, revised_at ),
    task_duration!subtask_id ( created, deadline ),
    task_output!subtask_id ( link ),
    task:task!inner(assignee),
    design_approval!id(*)`

export const taskRow = (t, activeUnitHeadId, userId) => {
    // Extract all pos_ids into an array: [11, 4]
    const roles = t.assignee_profile?.positions?.map(r => r.pos_id) || [];
    const units = t.assignee_profile?.positions?.map(r => r.unit_id) || [];

  // Logic from your resolveUnitIds
  const preferredUnit =
    activeUnitHeadId && units.includes(activeUnitHeadId)
      ? activeUnitHeadId
      : (units[0] ?? null);

    return ({
        id: t.id,
        parentId: t.parent_ppa_id,
        assigner: t.assigner,
        assignee: t.assignee,
        assigneeName: resolveNames(t.assignee_profile),
        assignerName: resolveNames(t.assigner_profile),
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
  const roles = t.assignee_profile?.positions?.map((r) => r.pos_id) || [];
  const units = t.assignee_profile?.positions?.map((r) => r.unit_id) || [];

  // Logic from your resolveUnitIds
  const preferredUnit =
    activeUnitHeadId && units.includes(activeUnitHeadId)
      ? activeUnitHeadId
      : (units[0] ?? null);

    return ({
        id: t.id,
        parentId: t.parent_ppa_id,
        assigner: t.assigner,
        assignee: t.assignee,
        assigneeName: resolveNames(t.assignee_profile),
        assignerName: resolveNames(t.assigner_profile),
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

export const selectAssigneeAssigner = async (supabase, taskId = null, subtaskId = null) => {
    const { data, error } = await supabase
        .from(taskId ? 'task' : 'subtask')
        .select('assignee, assigner')
        .eq('id', taskId || subtaskId)
        .maybeSingle()

    if (error) throw error;
    if (!data) throw new Error('Record not found');

    return data
}