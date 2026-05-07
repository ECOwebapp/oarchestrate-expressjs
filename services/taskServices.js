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
  const APPROVAL = `unit_head, director, revised_at`;
  const DURATION = `created, deadline`;
  const OUTPUT = `link`;

  if (isSubtask) {
    return `
        id, parent_task_id, parent_subtask_id, assigner, assignee, design,
        assignee_profile:user_profile!subtask_assignee_fkey (${PROFILE_FIELDS}),
        assigner_profile:user_profile!subtask_assigner_fkey (${PROFILE_FIELDS}),
        task_profile!subtask_id!inner (${TASK_INFO}),
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
        id, parent_ppa_id, assigner, assignee,
        assignee_profile:user_profile!task_assignee_fkey1 (${PROFILE_FIELDS}),
        assigner_profile:user_profile!task_assigner_fkey1 (${PROFILE_FIELDS}),
        task_profile!inner(${TASK_INFO}),
        task_approval(${APPROVAL}),
        task_duration(${DURATION}),
        task_output(${OUTPUT})
    `
      .replace(/\s+/g, " ")
      .trim();
  }
};

const formatRow = (
  t,
  activeUnitHeadId,
  userId,
  comments,
  isSubtask = false,
) => {
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
    outputLink: t.task_output?.link || "",
    unitHead: !!t.task_approval?.unit_head,
    director: !!t.task_approval?.director,
    revisionComment: comments?.find(
      (c) => t.id === c.task_id || t.id === c.subtask_id,
    )?.message,
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
  if (isSubtask) {
    base.design = !!t.design;
    base.designApproval = t.design_approval || {};
    base.isSubtask = isSubtask;
  }

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
  insertion = false,
) => {
  const { isDirector, isUnitHead } = await resolvePosUnitIds(supabase, userId);
  const activeUnitHeadId = isUnitHead?.unit_id || null;

  let query = supabase.from("task").select(SELECT_QUERY(false));
  if (parentId) query = query.eq("parent_ppa_id", Number(parentId));
  else if (taskId) query = query.eq("id", Number(taskId));
  else if (insertion) {
    if (!isDirector) query = query.eq("assignee", userId);
    query = query.eq("task_profile.task_type", 2);
  }
  const [{ data: tasks, error }, { data: comments, error: commentErr }] =
    await Promise.all([
      query.order("id", { ascending: false }),
      supabase
        .from("comment_section")
        .select(`id, user_id, task_id, message, created_at`),
    ]);
  if (error) throw error;
  if (commentErr) throw commentErr;

  return tasks.map((t) =>
    formatRow(t, activeUnitHeadId, userId, comments, false),
  );
};

export const fetchSubtasks = async (
  supabase,
  userId,
  subtaskId = null,
  parentId = null,
  design = false,
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
  else if (design) query = query.eq("design", design);

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

  const { data: comments } = await supabase
    .from("comment_section")
    .select(`id, user_id, subtask_id, message, created_at`);

  // 3. Final Mapping
  // Pass the requester's ID to mapRow to handle 'isOwnTask' logic on the server
  return subtaskRows.map((st) =>
    formatRow(st, activeUnitHeadId, userId, comments, true),
  );
};

/* Dashboard tasks */
export const processDashboardTasks = (
  tasks,
  auth,
  selectedMonth,
  selectedYear,
  CIRC,
) => {
  if (!tasks || !Array.isArray(tasks)) return {};

  // ── Filtered tasks for current month ──
  const forMonth = (list) =>
    list.filter((t) => {
      if (!t.from) return false;
      const d = new Date(t.from);
      return d.getMonth() === selectedMonth && d.getFullYear() === selectedYear;
    });

  // -----------------------------------------
  // DIRECTOR LOGIC
  // -----------------------------------------
  const directorPending = tasks.filter((t) => !t.director);
  const directorMonth = forMonth(directorPending); // Evaluated immediately

  const directorRegular = directorMonth
    .filter((t) => t.typeId !== 2 && t.outputLink)
    .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));

  const directorInsertion = directorMonth
    .filter((t) => t.typeId === 2)
    .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));

  // Pre-calculate counts for the donut to avoid redundant filtering
  const dirRegCount = directorMonth.filter(
    (t) => t.typeId !== 2 && !t.urgent && t.outputLink,
  ).length;
  const dirUrgCount = directorMonth.filter((t) => t.urgent).length;
  const dirInsCount = directorMonth.filter((t) => t.typeId === 2).length;
  const dirTotal = dirRegCount + dirUrgCount + dirInsCount || 1;

  let dirOffset = 0;
  const directorDonut = [
    { value: dirRegCount, color: "#15803d", label: "Regular" },
    { value: dirUrgCount, color: "#b91c1c", label: "Urgent" },
    { value: dirInsCount, color: "#b45309", label: "Insertion" },
  ].map((s) => {
    const len = CIRC * (s.value / dirTotal); // FIXED: s.value
    const seg = { ...s, len, offset: -dirOffset };
    dirOffset += len;
    return seg;
  });

  // -----------------------------------------
  // UNIT HEAD LOGIC
  // -----------------------------------------
  const uhPending = tasks.filter(
    (t) => !t.isOwnTask && !t.unitHead && !t.director,
  );
  const uhOwn = tasks.filter((t) => t.isOwnTask);
  const uhMonth = forMonth(uhPending);

  const uhRegular = uhMonth
    .filter((t) => t.typeId !== 2 && t.outputLink)
    .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));

  const uhInsertion = uhMonth
    .filter((t) => t.typeId === 2)
    .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));

  const uhRegCount = uhMonth.filter(
    (t) => t.typeId !== 2 && !t.urgent && t.outputLink,
  ).length;
  const uhUrgCount = uhMonth.filter((t) => t.urgent).length;
  const uhInsCount = uhMonth.filter((t) => t.typeId === 2).length;
  const uhTotal = uhRegCount + uhUrgCount + uhInsCount || 1;

  let uhOffset = 0;
  const uhDonut = [
    { value: uhRegCount, color: "#15803d", label: "Regular" },
    { value: uhUrgCount, color: "#b91c1c", label: "Urgent" },
    { value: uhInsCount, color: "#b45309", label: "Insertion" },
  ].map((s) => {
    const len = CIRC * (s.value / uhTotal); // FIXED: s.value
    const seg = { ...s, len, offset: -uhOffset };
    uhOffset += len;
    return seg;
  });

  // -----------------------------------------
  // MEMBER LOGIC
  // -----------------------------------------
  const memberRegular = tasks
    .filter((t) => t.typeId !== 2)
    .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));

  const memberInsertion = tasks
    .filter((t) => t.typeId === 2 && !t.design)
    .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));

  const memberRevisions = tasks.filter((t) => t.revision && !t.director);

  const memAppCount = tasks.filter((t) => t.director).length;
  const memSubCount = tasks.filter(
    (t) => (t.outputLink && !t.director) || t.design,
  ).length;
  const memPenCount = tasks.filter(
    (t) => !t.outputLink && !t.director && !t.design,
  ).length;
  const memTotal = memAppCount + memSubCount + memPenCount || 1;

  let memOffset = 0;
  const memberDonut = [
    { value: memAppCount, color: "#15803d", label: "Approved" },
    { value: memSubCount, color: "#b45309", label: "Submitted" },
    { value: memPenCount, color: "#9ca3af", label: "Pending" },
  ].map((s) => {
    const len = CIRC * (s.value / memTotal); // FIXED: s.value
    const seg = { ...s, len, offset: -memOffset };
    memOffset += len;
    return seg;
  });

  // -----------------------------------------
  // FINAL EXPORT BASED ON ROLE
  // -----------------------------------------
  return {
    activeDonut: auth.isDirector
      ? directorDonut
      : auth.isUnitHead
        ? uhDonut
        : memberDonut,
    activePending: auth.isDirector
      ? directorMonth
      : auth.isUnitHead
        ? uhMonth
        : tasks,
    activeRegular: auth.isDirector
      ? directorRegular
      : auth.isUnitHead
        ? uhRegular
        : memberRegular,
    activeInsertion: auth.isDirector
      ? directorInsertion
      : auth.isUnitHead
        ? uhInsertion
        : memberInsertion,
    uhOwn: auth.isUnitHead ? uhOwn : null,
    memberRevisions:
      !auth.isDirector && !auth.isUnitHead ? memberRevisions : null,
  };
};
