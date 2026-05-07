import express from "express";
import {
  selectAssigneeAssigner,
  resolveNames,
  fetchTasks,
} from "../services/taskServices.js";
import { resolvePosUnitIds } from "../services/helperServices.js";
import { _notifySubmission } from "../services/notificationServices.js";
const router = express.Router();

// Tasks that are children of a PPA
router.get("/fetch", async (req, res) => {
  const { taskId, parentId, insertion } = req.query;

  try {
    const formattedTasks = await fetchTasks(
      req.supabase,
      req.user.id,
      taskId,
      parentId,
      insertion,
    );
    return res.status(200).json(taskId ? formattedTasks[0] : formattedTasks);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get("/fetch_revisions", async (req, res) => {
  const { taskId } = req.query;
  try {
    const { data: revisionData } = await req.supabase
      .from("task_revision")
      .select(
        `
          id,
          task_id,
          from_user,
          fromName:user_profile!task_revision_from_user_fkey(
            fname,
            lname,
            middle_initial
          ),
          to_user,
          role,
          comment:comment_section!comment_section_revision_id_fkey(message)
          is_read,
          created_at
          `,
      )
      .eq("task_id", taskId)
      .order("created_at", { ascending: true });

    const unread = (revisionData || [])
      .filter((r) => r.to_user === req.user.id && !r.is_read)
      .map((r) => r.id);
    if (unread.length) {
      await req.supabase
        .from("task_revision")
        .update({ is_read: true })
        .in("id", unread);
    }

    const result = (revisionData || []).map((r) => {
      // 1. Handle the nested comment array from Supabase
      // If using a relationship, r.comments will be an array [ { message: "..." } ]
      const commentObj = Array.isArray(r.comment) ? r.comment[0] : r.comment;

      return {
        ...r,
        // Use optional chaining to prevent crashes if message is missing
        comment: commentObj?.message,

        // 2. Resolve the name string
        fromName: resolveNames(r.fromName),
      };
    });

    return res.status(200).json(result);
  } catch (err) {
    console.log("Error fetching revisions: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/upsert", async (req, res) => {
  const { mainTask } = req.body;

  try {
    // 1. Resolve Requester Roles & Units
    const { isDirector, isMember } = await resolvePosUnitIds(
      req.supabase,
      req.user.id,
    );

    // 2. Determine Assignee
    // If they are a member, they can only assign to themselves.
    const assigneeId = isMember
      ? req.user.id
      : mainTask.assignee || req.user.id;

    // 3. Prepare the Base Task Data
    let taskData = {
      parent_ppa_id: mainTask.parentId,
      assigner: mainTask.assignee ? req.user.id : null,
      assignee: mainTask.assignee ? assigneeId : null,
    };
    if (mainTask.id) taskData.id = mainTask.id;

    // 4. Execute Main Task Upsert
    const { data: taskRow, error: taskErr } = await req.supabase
      .from("task")
      .upsert(taskData, { onConflict: "id" })
      .select("id")
      .single();

    if (taskErr) throw taskErr;
    const taskId = taskRow.id;

    // 5. Approval Logic (Business Rules)
    const { userUnitId } = await resolvePosUnitIds(
      req.supabase,
      assigneeId,
      null,
    );

    const isOfficeMember = userUnitId.includes(3); // Assuming 3 is Office

    const isSelfAssigned = assigneeId === req.user.id;
    const isDirectorSelfAssign = isDirector && isSelfAssigned;
    const hasOutput = !!mainTask.outputLink;

    let initialUnitHead = false;
    let initialDirector = false;

    if (isDirectorSelfAssign) {
      initialUnitHead = true;
      initialDirector = true;
    } else if (
      (isSelfAssigned && mainTask.type === 2) ||
      (hasOutput && isOfficeMember)
    ) {
      initialUnitHead = true;
    }

    // 6. Bulk Upsert Metadata
    // We use Promise.all to hit the related tables in parallel
    const upserts = [
      req.supabase.from("task_profile").upsert(
        {
          task_id: taskId,
          title: mainTask.name,
          description: mainTask.description,
          task_type: mainTask.type,
          urgent: !!mainTask.urgent,
        },
        { onConflict: "task_id" },
      ),
      req.supabase.from("task_approval").upsert(
        {
          task_id: taskId,
          unit_head: initialUnitHead,
          director: initialDirector,
        },
        { onConflict: "task_id" },
      ),
      req.supabase.from("task_duration").upsert(
        {
          task_id: taskId,
          deadline: mainTask.endDate,
        },
        { onConflict: "task_id" },
      ),
    ];

    if (hasOutput) {
      upserts.push(
        req.supabase.from("task_output").upsert(
          {
            task_id: taskId,
            link: mainTask.outputLink,
          },
          { onConflict: "task_id" },
        ),
      );
    }

    await Promise.all(upserts);

    // 7. Notification Logic
    // In Express, you can trigger this and NOT await it if you want to speed up the response
    if ((hasOutput && !isDirectorSelfAssign) || mainTask.assignee) {
      // Assuming _notifySubmission is a helper function in your backend
      await _notifySubmission(
        req.supabase,
        taskId,
        null,
        assigneeId,
        req.user.id,
        null,
        isSelfAssigned,
      );
    }

    const formattedTasks = await fetchTasks(
      req.supabase,
      req.user.id,
      null,
      taskData.parent_ppa_id,
    );
    taskData = {};
    return res.status(200).json(formattedTasks);
  } catch (err) {
    console.log("Error adding tasks: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/delete", async (req, res) => {
  const { taskIds, parentId } = req.body;
  try {
    const { isDirector, isUnitHead, isMember } = await resolvePosUnitIds(
      req.supabase,
      req.user.id,
    );

    if (isMember)
      throw new Error("You do not have permission to delete tasks.");

    let allowedIds = [...taskIds];
    if (isUnitHead && !isDirector) {
      const { data: validTasks, error } = await req.supabase
        .from("task")
        .select("id")
        .in("id", taskIds)
        .eq("assigner", req.user.id);

      if (error) throw error;

      // Map the results to get the IDs that actually matched
      allowedIds = validTasks.map((t) => t.id);

      if (allowedIds.length === 0)
        return res
          .status(403)
          .json({ error: "You can only delete tasks that you assigned." });

      // Optional: If you want to block the whole operation if even ONE ID is unauthorized:
      if (allowedIds.length !== taskIds.length)
        return res.status(403).json({
          error: "Unauthorized: Some tasks were not assigned by you.",
        });
    }

    let result;
    const del = async (table, column, ids) => {
      if (!ids.length) return;
      let query = req.supabase.from(table).delete().in(column, ids);
      if (table === "task") {
        query = query.select();
      }
      const { data, error } = await query;
      if (error) throw new Error(`[deleteTasks]: ${table} | ${error.message}`);
      if (table === "task") result = data;
    };

    await Promise.all([
      del("task_revision", "task_id", allowedIds),
      del("task_poke", "task_id", allowedIds),
      del("comment_section", "task_id", allowedIds),
      del("task_notif", "task_id", allowedIds),
      del("task_output", "task_id", allowedIds),
      del("task_approval", "task_id", allowedIds),
      del("task_duration", "task_id", allowedIds),
      del("task_profile", "task_id", allowedIds),
      del("task", "id", allowedIds),
    ]);

    const formattedTasks = await fetchTasks(
      req.supabase,
      req.user.id,
      null,
      parentId,
    );
    return res.status(200).json(formattedTasks);
  } catch (err) {
    console.log("Error deleting tasks: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/approve", async (req, res) => {
  const { taskId, role, parentId } = req.body;

  try {
    const { data: task } = await req.supabase
      .from("task")
      .select("design, assignee")
      .eq("id", taskId);

    if (!task) throw new Error("Task not found");

    // Handle regular task approvals
    const col = role === 1 ? "director" : "unit_head";
    const { error: updateErr } = await req.supabase
      .from("task_approval")
      .update({ [col]: true, revised_at: null })
      .eq("task_id", taskId);

    if (updateErr) throw new Error(updateErr.message);

    const formattedTasks = await fetchTasks(
      req.supabase,
      req.user.id,
      null,
      parentId,
    );
    return res.status(200).json(formattedTasks);
  } catch (err) {
    console.log("Error approving task: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/revision_request", async (req, res) => {
  const { taskId, comment, role, parentId } = req.body;

  try {
    const { data: task } = await req.supabase
      .from("task")
      .select("assignee")
      .eq("id", taskId)
      .maybeSingle();

    if (!task) throw new Error("Task not found");

    // Regular task revision logic
    const resetCols =
      role === 1
        ? {
            unit_head: false,
            director: false,
            revised_at: new Date().toISOString(),
          }
        : {
            unit_head: false,
            revised_at: new Date().toISOString(),
          };

    const [taskApp, taskProf, taskRev] = await Promise.all([
      req.supabase
        .from("task_approval")
        .update(resetCols)
        .eq("task_id", taskId),
      req.supabase
        .from("task_profile")
        .update({ revision: true })
        .eq("task_id", taskId),
      req.supabase
        .from("task_revision")
        .insert({
          task_id: taskId,
          from_user: req.user.id,
          to_user: task.assignee,
          role,
          is_read: false,
        })
        .select("id")
        .maybeSingle(),
    ]);
    const { error: commentErr } = await req.supabase
      .from("comment_section")
      .insert({
        user_id: req.user.id,
        task_id: taskId,
        message: comment,
        revision_id: taskRev.data.id,
      });

    if (taskRev.error) throw taskRev.error;
    if (commentErr) throw commentErr;

    const formattedTasks = await fetchTasks(
      req.supabase,
      req.user.id,
      null,
      parentId,
    );
    return res.status(200).json(formattedTasks);
  } catch (err) {
    console.log("Error requesting revision: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/resubmit", async (req, res) => {
  const { taskId, newOutputLink, comment, parentId } = req.body;

  if (!comment) throw new Error("No comment");

  try {
    const { data: task } = await req.supabase
      .from("task")
      .select("id, assignee")
      .eq("id", taskId);

    if (!task) throw new Error("Task not found");

    if (newOutputLink) {
      const { data: updated, error: updErr } = await req.supabase
        .from("task_output")
        .update({ link: newOutputLink })
        .eq("task_id", taskId)
        .select("id");
      if (updErr) throw new Error(updErr.message);
      if (!updated || updated.length === 0) {
        const { error: insErr } = await req.supabase
          .from("task_output")
          .insert({ task_id: taskId, link: newOutputLink });
        if (insErr) throw new Error(insErr.message);
      }
    }

    const [{ data: lastRevision }, taskProf] = await Promise.all([
      req.supabase
        .from("task_revision")
        .select("id, role, from_user")
        .eq("task_id", taskId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),

      req.supabase
        .from("task_profile")
        .update({ revision: false })
        .eq("task_id", taskId),
    ]);

    const revisorRole = lastRevision?.role || 4;
    const assigneeId = task?.assignee || req.user.id;

    let dbQueries = [];

    if (revisorRole === 1) {
      dbQueries.push(
        req.supabase
          .from("task_approval")
          .update({
            unit_head: true,
            director: false,
            revised_at: null,
          })
          .eq("task_id", taskId),
      );

      if (lastRevision?.from_user) {
        dbQueries.push(
          req.supabase
            .from("task_revision")
            .insert({
              task_id: taskId,
              from_user: req.user.id,
              to_user: lastRevision.from_user,
              role: 1,
              is_read: false,
            })
            .select("id")
            .maybeSingle(),
        );
      }

      dbQueries.push(
        req.supabase.from("task_notif").upsert(
          {
            task_id: taskId,
            read_by_director: false,
            read_by_assignee: true,
            read_by_unit_head: true,
          },
          { onConflict: "task_id" },
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
        taskId,
        null,
      );
      const isSelfAssigned = assignerData?.assigner === assigneeId;

      if (isOfficeMember || isSelfAssigned) {
        dbQueries.push(
          req.supabase
            .from("task_approval")
            .update({ unit_head: true, revised_at: null })
            .eq("task_id", taskId),
        );
      } else {
        dbQueries.push(
          req.supabase
            .from("task_approval")
            .update({ revised_at: null })
            .eq("task_id", taskId),
        );
      }

      if (lastRevision?.from_user) {
        dbQueries.push(
          req.supabase
            .from("task_revision")
            .insert({
              task_id: taskId,
              from_user: req.user.id,
              to_user: lastRevision.from_user,
              role: 4,
              is_read: false,
            })
            .select("id")
            .maybeSingle(),
        );
      }

      dbQueries.push(
        _notifySubmission(
          req.supabase,
          taskId,
          null,
          assigneeId,
          req.user.id,
          "📎 Revised output resubmitted — awaiting your review.",
          isSelfAssigned,
        ),
      );
    }

    const [taskApp, taskRev, taskNotif] = await Promise.all(dbQueries);
    if (taskRev) {
      const { error: commentErr } = await req.supabase
        .from("comment_section")
        .insert({
          user_id: req.user.id,
          subtask_id: task.id,
          message: comment,
          revision_id: taskRev?.data?.id,
        });
      if (commentErr) throw commentErr;
    } else throw taskRev.error;

    const formattedTasks = await fetchTasks(
      req.supabase,
      req.user.id,
      null,
      parentId,
    );
    return res.status(200).json(formattedTasks);
  } catch (err) {
    console.log("Error resubmiting: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
