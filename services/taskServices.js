import { resolvePosUnitIds } from "./helperServices.js";

export const resolveNames = (user) => {
  if (!user) return null;
  return `${user.fname || ""} ${user.middle_initial || ""} ${user.lname || ""}`;
};

export const columnResolver = (taskId, subtaskId) => {
  const idColumn = subtaskId ? "subtask_id" : "task_id";
  const targetId = subtaskId || taskId;

  return { idColumn, targetId };
};

const SELECT_QUERY = (isSubtask = false) => {
  const PROFILE_FIELDS = `fname, middle_initial, lname, positions:position(unit_id, pos_id)`;
  const TASK_INFO = `title, description, urgent, revision, task_type, task_type_ref:task_type(task_type)`;
  const APPROVAL = `unit_head, director, revision_comment, revised_at`;
  const DURATION = `created, deadline`;
  const OUTPUT = `link`;

  if (isSubtask) {
    return `
        id, parent_task_id, parent_subtask_id, assigner, assignee, design,
        assignee_profile:user_profile!subtask_assignee_fkey (${PROFILE_FIELDS}),
        assigner_profile:user_profile!subtask_assigner_fkey (${PROFILE_FIELDS}),
        task_profile!subtask_id (${TASK_INFO}),
        task_approval!subtask_id (${APPROVAL}),
        task_duration!subtask_id (${DURATION}),
        task_output!subtask_id (${OUTPUT}),
        task:task!inner(assignee),
        design_approval!id(*)
    `
      .replace(/\s+/g, " ")
      .trim();
  } else {
    return `
        id, parent_ppa_id, assigner, assignee, design,
        assignee_profile:user_profile!task_assignee_fkey1 (${PROFILE_FIELDS}),
        assigner_profile:user_profile!task_assigner_fkey1 (${PROFILE_FIELDS}),
        task_profile(${TASK_INFO}),
        task_approval(${APPROVAL}),
        task_duration(${DURATION}),
        task_output(${OUTPUT})
    `
      .replace(/\s+/g, " ")
      .trim();
  }
};

const formatRow = (t, activeUnitHeadId, userId, isSubtask = false) => {
  const roles = t.assignee_profile?.positions?.map((r) => r.pos_id) || [];
  const units = t.assignee_profile?.positions?.map((r) => r.unit_id) || [];

  const preferredUnit =
    activeUnitHeadId && units.includes(activeUnitHeadId)
      ? activeUnitHeadId
      : (units[0] ?? null);

  const base = {
    id: t.id,
    // Use the correct parent ID field depending on table type
    parentId: isSubtask ? t.parent_task_id : t.parent_ppa_id,
    assigner: t.assigner,
    assignee: t.assignee,
    assigneeName: resolveNames(t.assignee_profile),
    assignerName: resolveNames(t.assigner_profile),
    name: t.task_profile?.title || "",
    description: t.task_profile?.description || "",
    urgent: !!t.task_profile?.urgent,
    revision: !!t.task_profile?.revision,
    type: t.task_profile?.task_type_ref?.task_type || "",
    typeId: t.task_profile?.task_type || null,
    from: t.task_duration?.created || null,
    to: t.task_duration?.deadline || null,
    startDate: t.task_duration?.created || null,
    endDate: t.task_duration?.deadline || null,
    outputLink: t.task_output?.link ?? "",
    unitHead: !!t.task_approval?.unit_head,
    director: !!t.task_approval?.director,
    revisionComment: t.task_approval?.revision_comment || "",
    revisedAt: t.task_approval?.revised_at || null,
    overdue: (() => {
      const dl = t.task_duration?.deadline
        ? new Date(t.task_duration.deadline)
        : null;
      if (!dl || t.task_approval?.director) return false;
      dl.setHours(23, 59, 59, 999);
      return dl < new Date();
    })(),
    overdueDays: (() => {
      const dl = t.task_duration?.deadline
        ? new Date(t.task_duration.deadline)
        : null;
      if (!dl || t.task_approval?.director) return 0;
      dl.setHours(23, 59, 59, 999);
      const diff = new Date() - dl;
      return diff > 0 ? Math.ceil(diff / 86400000) : 0;
    })(),
    design: !!t.design,
    isSelfAssigned: t.assigner === t.assignee,
    assigneeRole: roles.includes(4)
      ? 4
      : roles.includes(1)
        ? 1
        : roles[0] || 11,
    assigneeUnitId: preferredUnit,
    assigneeIsOffice: preferredUnit === 3,
    isOwnTask: t.assignee === userId,
  };

  // Add subtask-specific field if needed
  if (isSubtask) base.designApproval = t.design_approval || {};

  return base;
};

export const selectAssigneeAssigner = async (
  supabase,
  taskId = null,
  subtaskId = null,
) => {
  const { data, error } = await supabase
    .from(taskId ? "task" : "subtask")
    .select("assignee, assigner")
    .eq("id", taskId || subtaskId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Record not found");

  return data;
};

export const fetchTasks = async (
  supabase,
  userId,
  taskId = null,
  parentId = null,
) => {
  const { isDirector, isUnitHead } = await resolvePosUnitIds(supabase, userId);
  const activeUnitHeadId = isUnitHead?.unit_id || null;

  let query = supabase.from("task").select(SELECT_QUERY(false));
  if (parentId) query = query.eq("parent_ppa_id", Number(parentId));
  else if (taskId) query = query.eq("id", taskId);

  const { data: tasks, error } = await query.order("id", { ascending: false });
  if (error) throw error;

  return tasks.map((t) => formatRow(t, activeUnitHeadId, userId, false));
};

export const fetchSubtasks = async (
  supabase,
  userId,
  subtaskId = null,
  parentId = null,
) => {
  // 1. Get Requester Metadata
  const { isDirector, isUnitHead } = await resolvePosUnitIds(
    supabase,
    userId,
    null,
  );
  const activeUnitHeadId = isUnitHead?.unit_id || null;

  let query = supabase.from("subtask").select(SELECT_QUERY(true));
  if (parentId) query = query.eq("parent_task_id", Number(parentId));
  else if (subtaskId) query = query.eq("id", subtaskId);

  let subtaskRows = [];

  // 2. Role-Based Fetching Logic
  if (isUnitHead) {
    // Unit Head Logic: The "Scenario B" Merge
    const { unitMembers } = await resolvePosUnitIds(
      supabase,
      null,
      activeUnitHeadId,
    );
    const allowedIds = [
      ...new Set([userId, ...(unitMembers?.map((m) => m.user_id) || [])]),
    ];

    // Parallel queries to handle the cross-table "OR" logic
    const [resDirect, resParent] = await Promise.all([
      supabase
        .from("subtask")
        .select(SELECT_QUERY(true))
        .in("assignee", allowedIds),
      supabase
        .from("subtask")
        .select(SELECT_QUERY(true))
        .in("task.assignee", allowedIds),
    ]);

    const combined = [...(resDirect.data || []), ...(resParent.data || [])];

    // Deduplicate and filter by parentId if provided
    subtaskRows = Array.from(new Map(combined.map((s) => [s.id, s])).values());
    if (parentId) {
      subtaskRows = subtaskRows.filter(
        (s) => s.parent_task_id === Number(parentId),
      );
    }

    subtaskRows.sort((a, b) => b.id - a.id);
  } else {
    // Regular Member Logic
    if (!isDirector) query = query.eq("assignee", userId);

    const { data, error } = await query.order("id", { ascending: false });
    if (error) throw error;
    subtaskRows = data || [];
  }

  // 3. Final Mapping
  // Pass the requester's ID to mapRow to handle 'isOwnTask' logic on the server
  return subtaskRows.map((st) => formatRow(st, activeUnitHeadId, userId, true));
};
