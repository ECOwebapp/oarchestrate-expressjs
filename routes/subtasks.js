import express from "express";
import {
  fetchSubtasks,
  selectAssigneeAssigner,
  resolveNames,
} from "../services/taskServices.js";
import { resolvePosUnitIds } from "../services/helperServices.js";
import { _notifySubmission } from "../services/notificationServices.js";
const router = express.Router();

router.get("/fetch", async (req, res) => {
  const { subtaskId, parentId, design } = req.query;

  try {
    const formattedSubtasks = await fetchSubtasks(
      req.supabase,
      req.user.id,
      subtaskId,
      parentId,
      design,
    );
    return res
      .status(200)
      .json(subtaskId ? formattedSubtasks[0] : formattedSubtasks);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post("/upsert", async (req, res) => {
  const { subTask } = req.body;

  try {
    // 1. Resolve Requester Roles & Units
    const { isDirector, isMember } = await resolvePosUnitIds(
      req.supabase,
      req.user.id,
    );

    // 2. Determine Assignee
    // If they are a member, they can only assign to themselves.
    const assigneeId = isMember ? req.user.id : subTask.assignee || req.user.id;

    // 3. Prepare the Base subtask Data
    let subtaskData = {
      parent_task_id: subTask.parentId,
      assigner: subTask.assignee ? req.user.id : null,
      assignee: subTask.assignee ? assigneeId : null,
      design: !!subTask.design,
    };
    if (subTask.id) subtaskData.id = subTask.id;

    // 4. Execute Main subtask Upsert
    const { data: subtaskRow, error: subtaskErr } = await req.supabase
      .from("subtask")
      .upsert(subtaskData, { onConflict: "id" })
      .select("id")
      .single();

    if (subtaskErr) throw subtaskErr;
    const subtaskId = subtaskRow.id;

    // 5. Approval Logic (Business Rules)
    const { userUnitId } = await resolvePosUnitIds(
      req.supabase,
      assigneeId,
      null,
    );

    const isOfficeMember = userUnitId.includes(3); // Assuming 3 is Office

    const isSelfAssigned = assigneeId === req.user.id;
    const isDirectorSelfAssign = isDirector && isSelfAssigned;
    const hasOutput = !!subTask.outputLink;

    let initialUnitHead = false;
    let initialDirector = false;

    if (isDirectorSelfAssign) {
      initialUnitHead = true;
      initialDirector = true;
    } else if (
      (isSelfAssigned && subTask.type === 2) ||
      (hasOutput && isOfficeMember)
    ) {
      initialUnitHead = true;
    }

    // 6. Bulk Upsert Metadata
    // We use Promise.all to hit the related tables in parallel
    const upserts = [
      req.supabase.from("task_profile").upsert(
        {
          subtask_id: subtaskId,
          title: subTask.name,
          description: subTask.description,
          task_type: subTask.type,
          urgent: !!subTask.urgent,
        },
        { onConflict: "subtask_id" },
      ),
      req.supabase.from("task_approval").upsert(
        {
          subtask_id: subtaskId,
          unit_head: initialUnitHead,
          director: initialDirector,
        },
        { onConflict: "subtask_id" },
      ),
      req.supabase.from("task_duration").upsert(
        {
          subtask_id: subtaskId,
          deadline: subTask.endDate,
        },
        { onConflict: "subtask_id" },
      ),
    ];

    if (hasOutput) {
      upserts.push(
        req.supabase.from("task_output").upsert(
          {
            subtask_id: subtaskId,
            link: subTask.outputLink,
          },
          { onConflict: "subtask_id" },
        ),
      );
    }

    if (subTask.oldAssignee) {
      upserts.push(
        req.supabase.from("subtask_assignment_log").upsert(
          {
            subtask_id: subtaskId,
            assigned_by: req.user.id,
            assigned_to: assigneeId,
            previous_assignee: subTask.oldAssignee,
          },
          { onConflict: "subtask_id" },
        ),
      );
    }

    await Promise.all(upserts);

    // 7. Notification Logic
    // In Express, you can trigger this and NOT await it if you want to speed up the response
    if ((hasOutput && !isDirectorSelfAssign) || subTask.assignee) {
      // Assuming _notifySubmission is a helper function in your backend
      await _notifySubmission(
        req.supabase,
        null, // subtask ID
        subtaskId,
        assigneeId,
        req.user.id,
        null,
        isSelfAssigned,
      );
    }
    const formattedSubtasks = await fetchSubtasks(
      req.supabase,
      req.user.id,
      null,
      subtaskData.parent_task_id,
    );
    subtaskData = {};
    return res.status(200).json(formattedSubtasks);
  } catch (err) {
    console.log("Error adding tasks: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/approve", async (req, res) => {
  const { subtaskId, role, parentId } = req.body;

  try {
    const { data: subtask } = await req.supabase
      .from("subtask")
      .select("design, assignee")
      .eq("id", subtaskId)
      .maybeSingle();
    if (!subtask) throw new Error("subtask not found");

    // Handle design subtask approvals
    if (subtask.design) {
      const designApprovalUpdate = {};
      let approvalMessage = "";
      const engineersId = new Set([13, 14, 15, 16, 18, 19]);

      // Can be coded with switch-case
      if (role === 6) {
        designApprovalUpdate.senior_draftsman = true;
        approvalMessage =
          "✅ Design approved by Senior Draftsman — forwarded to Engineers.";
      } else if (engineersId.has(role)) {
        designApprovalUpdate.engineers = true;
        approvalMessage =
          "✅ Design approved by Engineer — forwarded to Unit Head.";
      } else if (role === 4) {
        designApprovalUpdate.unit_head = true;
        approvalMessage =
          "✅ Design approved by Unit Head — forwarded to Director.";
      } else if (role === 1) {
        designApprovalUpdate.director = true;
        approvalMessage = "✅ Design fully approved by Director.";
      }

      // Update design_approval table (using id from subtask relationship if exists)
      const [{ error: updateErr }, { error: revisionErr }] = await Promise.all([
        req.supabase
          .from("design_approval")
          .update(designApprovalUpdate)
          .eq("id", subtaskId),
        req.supabase.from("task_revision").insert({
          subtask_id: subtaskId,
          from_user: req.user.id,
          to_user: subtask.assignee,
          role: role,
          comment: approvalMessage,
          is_read: false,
        }),
      ]);

      if (updateErr) throw new Error(updateErr.message);
      if (revisionErr) throw new Error(revisionErr.message);
    } else {
      // Handle regular subtask approvals
      const col = role === 1 ? "director" : "unit_head";
      const [{ error: updateErr }, { error: revisionErr }] = await Promise.all([
        req.supabase
          .from("task_approval")
          .update({ [col]: true, revision_comment: null, revised_at: null })
          .eq("subtask_id", subtaskId),

        req.supabase.from("task_revision").insert({
          subtask_id: subtaskId,
          from_user: req.user.id,
          to_user: subtask.assignee,
          role: role,
          comment:
            role === 1
              ? "✅ Subtask fully approved by Director."
              : "✅ Subtask approved by Unit Head — forwarded to Director.",
          is_read: false,
        }),
      ]);

      if (updateErr) throw new Error(updateErr.message);
      if (revisionErr) throw new Error(revisionErr.message);
    }

    const formattedSubtasks = await fetchSubtasks(
      req.supabase,
      req.user.id,
      null,
      parentId,
    );
    return res.status(200).json(formattedSubtasks);
  } catch (err) {
    console.log("Error approving subtask: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/resubmit", async (req, res) => {
  const { subtaskId, newOutputLink, parentId } = req.body;

  try {
    const { data: subtask } = await req.supabase
      .from("subtask")
      .select("assignee")
      .eq("id", subtaskId)
      .maybeSingle();

    if (!subtask) throw new Error("Subtask not found");

    if (newOutputLink) {
      const { data: updated, error: updErr } = await req.supabase
        .from("task_output")
        .update({ link: newOutputLink })
        .eq("subtask_id", subtaskId)
        .select("id");
      if (updErr) throw new Error(updErr.message);
      if (!updated || updated.length === 0) {
        const { error: insErr } = await req.supabase
          .from("task_output")
          .insert({ subtask_id: subtaskId, link: newOutputLink });
        if (insErr) throw new Error(insErr.message);
      }
    }

    const [lastRevision, taskProfileUpdate] = await Promise.all([
      req.supabase
        .from("task_revision")
        .select("role, from_user")
        .eq("subtask_id", subtaskId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),

      req.supabase
        .from("task_profile")
        .update({ revision: false })
        .eq("subtask_id", subtaskId),
    ]);

    const revisorRole = lastRevision?.role || 4;
    const assigneeId = subtask?.assignee || req.user.id;

    let dbQueries = [];
    if (revisorRole === 1) {
      dbQueries.push(
        req.supabase
          .from("task_approval")
          .update({
            unit_head: true,
            director: false,
            revision_comment: null,
            revised_at: null,
          })
          .eq("subtask_id", subtaskId),
      );

      if (lastRevision?.from_user) {
        dbQueries.push(
          req.supabase.from("task_revision").insert({
            subtask_id: subtaskId,
            from_user: req.user.id,
            to_user: lastRevision.from_user,
            role: 1,
            comment:
              "📎 Revised output resubmitted — awaiting your final approval.",
            is_read: false,
          }),
        );
      }
      dbQueries.push(
        req.supabase.from("task_notif").upsert(
          {
            subtask_id: subtaskId,
            read_by_director: false,
            read_by_assignee: true,
            read_by_unit_head: true,
          },
          { onConflict: "subtask_id" },
        ),
      );
    } else {
      const { isOfficeMember } = await resolvePosUnitIds(
        req.supabase,
        assigneeId,
        null,
      );
      const assignerData = await selectAssigneeAssigner(
        req.supabase,
        null,
        subtaskId,
      );
      const isSelfAssigned = assignerData?.assigner === assigneeId;

      if (isOfficeMember || isSelfAssigned) {
        dbQueries.push(
          req.supabase
            .from("task_approval")
            .update({
              unit_head: true,
              director: false,
              revision_comment: null,
              revised_at: null,
            })
            .eq("subtask_id", subtaskId),
        );
      } else {
        dbQueries.push(
          req.supabase
            .from("task_approval")
            .update({
              unit_head: false,
              director: false,
              revision_comment: null,
              revised_at: null,
            })
            .eq("subtask_id", subtaskId),
        );
      }

      dbQueries.push(
        _notifySubmission(
          req.supabase,
          null,
          subtaskId,
          assigneeId,
          req.user.id,
          "📎 Revised output resubmitted — awaiting your review.",
          isSelfAssigned,
        ),
      );
    }

    // Need to be tested.
    // In theory, running these queries at the same time is better
    // than running them in sequential since these queries does not return data.
    await Promise.all(dbQueries);
    const formattedSubtasks = await fetchSubtasks(
      req.supabase,
      req.user.id,
      null,
      parentId,
    );
    return res.status(200).json(formattedSubtasks);
  } catch (err) {
    console.log("Error resubmiting: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/delete", async (req, res) => {
  const { subtaskIds, parentId } = req.body;
  try {
    const { isDirector, isUnitHead, isMember } = await resolvePosUnitIds(
      req.supabase,
      req.user.id,
    );

    if (isMember)
      throw new Error("You do not have permission to delete subtasks.");

    let allowedIds = [...subtaskIds];
    if (isUnitHead && !isDirector) {
      const { data: validTasks, error } = await req.supabase
        .from("subtask")
        .select("id")
        .in("id", subtaskIds)
        .eq("assigner", req.user.id);

      if (error) throw error;

      // Map the results to get the IDs that actually matched
      allowedIds = validTasks.map((t) => t.id);

      if (allowedIds.length === 0)
        return res
          .status(403)
          .json({ error: "You can only delete subtasks that you assigned." });

      // Optional: If you want to block the whole operation if even ONE ID is unauthorized:
      if (allowedIds.length !== subtaskIds.length)
        return res.status(403).json({
          error: "Unauthorized: Some subtasks were not assigned by you.",
        });
    }

    let result = {};
    const del = async (table, column, ids) => {
      if (!ids.length) return;
      let query = req.supabase.from(table).delete().in(column, ids);
      if (table === "subtask") {
        query = query.select();
      }
      const { data, error } = await query;
      if (error)
        throw new Error(`[deleteSubtasks]: ${table} | ${error.message}`);
      if (table === "subtask") result = data;
    };

    await Promise.all([
      del("task_revision", "subtask_id", allowedIds),
      del("task_poke", "subtask_id", allowedIds),
      del("comment_section", "subtask_id", allowedIds),
      del("task_notif", "subtask_id", allowedIds),
      del("task_output", "subtask_id", allowedIds),
      del("task_approval", "subtask_id", allowedIds),
      del("task_duration", "subtask_id", allowedIds),
      del("task_profile", "subtask_id", allowedIds),
      del("subtask", "id", allowedIds),
    ]);

    const formattedSubtasks = await fetchSubtasks(
      req.supabase,
      req.user.id,
      null,
      parentId,
    );
    return res.status(200).json(formattedSubtasks);
  } catch (err) {
    console.log("Error deleting tasks: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/** REVISIONS */

router.get("/fetch_revisions", async (req, res) => {
  const { subtaskId } = req.query;
  try {
    const { data } = await req.supabase
      .from("task_revision")
      .select(
        `
          id,
          subtask_id,
          from_user,
          fromName:user_id!task_revision_from_user_fkey(
            fname,
            lname,
            middle_initial
          ),
          to_user,
          role,
          comment,
          is_read,
          created_at
          `,
      )
      .eq("subtask_id", subtaskId)
      .order("created_at", { ascending: true });

    const unread = (data || [])
      .filter((r) => r.to_user === req.user.id && !r.is_read)
      .map((r) => r.id);
    if (unread.length) {
      await req.supabase
        .from("task_revision")
        .update({ is_read: true })
        .in("id", unread);
    }

    return res.status(200).json(
      (data || []).map((r) => ({
        ...r,
        fromName: resolveNames[r.fromName],
      })),
    );
  } catch (err) {
    console.log("Error fetching revisions: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/revision_request", async (req, res) => {
  const { subtaskId, comment, role, parentId } = req.body;

  try {
    const { data: subtask } = await req.supabase
      .from("subtask")
      .select("design, assignee")
      .eq("id", subtaskId);

    if (!subtask) throw new Error("Subtask not found");

    if (subtask.design) {
      // For design tasks, reset the relevant approval flag based on the role
      const designResetCols = {};
      const engineersId = new Set([13, 14, 15, 16, 18, 19]);

      if (role === 1) {
        // Director resets all flags
        designResetCols.senior_draftsman = false;
        designResetCols.engineers = false;
        designResetCols.unit_head = false;
        designResetCols.director = false;
      } else if (role === 4) {
        // Unit head resets from engineers onwards
        designResetCols.engineers = false;
        designResetCols.unit_head = false;
      } else if (role.find((id) => engineersId.has(id))) {
        // Engineers reset themselves
        designResetCols.engineers = false;
      }

      await Promise.all([
        req.supabase
          .from("task_profile")
          .update({ revision: true })
          .eq("subtask_id", subtaskId),
        req.supabase.from("task_revision").insert({
          subtask_id: subtaskId,
          from_user: req.user.id,
          to_user: subtask.assignee,
          role,
          comment,
          is_read: false,
        }),
      ]);
    } else {
      // Regular subtask revision logic
      const resetCols =
        role === 1
          ? {
              unit_head: false,
              director: false,
              revision_comment: comment,
              revised_at: new Date().toISOString(),
            }
          : {
              unit_head: false,
              revision_comment: comment,
              revised_at: new Date().toISOString(),
            };

      await Promise.all([
        req.supabase
          .from("task_approval")
          .update(resetCols)
          .eq("subtask_id", subtaskId),
        req.supabase
          .from("task_profile")
          .update({ revision: true })
          .eq("subtask_id", subtaskId),
        req.supabase.from("task_revision").insert({
          subtask_id: subtaskId,
          from_user: req.user.id,
          to_user: subtask.assignee,
          role,
          comment,
          is_read: false,
        }),
      ]);
    }

    const formattedSubtasks = await fetchSubtasks(
      req.supabase,
      req.user.id,
      null,
      parentId,
    );
    return res.status(200).json(formattedSubtasks);
  } catch (err) {
    console.log("Error requesting revision: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
