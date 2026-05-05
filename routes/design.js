import express from "express";
import { resolveNames } from "../services/taskServices.js";
const router = express.Router();

const POS_UNIT_HEAD = 4;
const POS_DIRECTOR = 1;
const PDU_UNIT_ID = 1;

router.get("/plenary_members", async (req, res) => {
  try {
    const { data, error } = await req.supabase.rpc("get_design_plenary");
    if (error) throw error;
    return res.status(200).json({ plenary: data }); // IDs: (13, 14, 15, 16, 18, 19)
  } catch (e) {
    console.log("Failed to fetch plenary members: ", e);
    return res.status(500).json({ error: e.message });
  }
});

router.get("/pdu_members", async (req, res) => {
  const { roleId } = req.query;
  try {
    let query = req.supabase
      .from("position")
      .select(
        `
                user_id,
                user:user_id!position_user_id_fkey(fname, lname, middle_initial),
                pos_id,
                unit_id`,
      )
      .eq("unit_id", PDU_UNIT_ID);
    if (roleId) query = query.eq("pos_id", roleId);

    const { data, error } = await query;
    if (error) throw error;
    return res.status(200).json({
      data: data.map((d) => ({
        ...d,
        user_name: resolveNames[d.user],
      })),
    });
  } catch (err) {
    console.error(
      `[Design] Error fetching PDU members for role ${roleId}:`,
      err,
    );
    return res.status(500).json({ error: err.message });
  }
});

router.post("/submit", async (req, res) => {
  const { subtaskId, juniorDraftsmanId } = req.body;
  try {
    const { error } = await req.supabase
      .from("subtask")
      .update({
        assignee: juniorDraftsmanId,
      })
      .eq("id", subtaskId);

    if (error) throw new Error(error);

    // Create or update initial design approval record (using upsert to avoid duplicate key errors)
    const { error: approvalErr } = await req.supabase
      .from("design_approval")
      .upsert(
        {
          id: subtaskId,
          engineers: false,
          senior_draftsman: false,
          unit_head: false,
          director: false,
        },
        {
          onConflict: "id",
        },
      );

    if (approvalErr) throw new Error(approvalErr);
    return res.status(201);
  } catch (err) {
    console.error("[Design] Error submitting design task:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/design_approval_status", async (req, res) => {
  const { subtaskId } = req.query;
  try {
    const { data, error } = await req.supabase
      .from("design_approval")
      .select("*")
      .eq("id", subtaskId)
      .single();

    if (error && error.code !== "PGRST116") throw error;
    return res.status(200).json({ data });
  } catch (err) {
    console.error("[Design] Error fetching approval status:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/senior_draftsman_action", async (req, res) => {
  const { subtaskId, action, comment } = req.body;
  try {
    const { error } = await req.supabase.rpc("design_senior_draftsman_action", {
      p_subtask_id: subtaskId,
      p_from_user: req.user.id,
      p_action: action, // 'approve' | 'revise'
      p_comment: comment,
    });

    if (error) throw error;
    return res.status(201);
  } catch (err) {
    console.error("[Design] Senior draftsman action failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/engineer_action", async (req, res) => {
  const { subtaskId, action, role, comment } = req.body;
  try {
    const { error } = await req.supabase.rpc("design_engineer_action", {
      p_subtask_id: subtaskId,
      p_from_user: req.user.id,
      p_action: action, // 'approve' | 'revise'
      p_role: role, // from among the ids within POS_ENGINEER
      p_comment: comment,
    });

    if (error) throw error;
    return res.status(201);
  } catch (err) {
    console.error("[Design] Senior draftsman action failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/check_all_engineers_approval", async (req, res) => {
  const { subtaskId } = req.query;
  try {
    const { data, error } = await req.supabase.rpc(
      "check_all_engineers_approved",
      { p_subtask_id: subtaskId },
    );

    if (error) throw error;
    return res.status(200).json({ data });
  } catch (err) {
    console.error("[Design] Error checking engineer approvals:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/unit_head_action", async (req, res) => {
  const { subtaskId, action, comment } = req.body;
  try {
    const { error } = await req.supabase.rpc("design_unit_head_action", {
      p_subtask_id: subtaskId,
      p_from_user: req.user.id,
      p_action: action, // 'approve' | 'revise'
      p_comment: comment,
    });

    if (error) throw error;
    return res.status(201);
  } catch (err) {
    console.error("[Design] Unit head action failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/director_action", async (req, res) => {
  const { subtaskId, action, comment } = req.body;
  try {
    const { error } = await req.supabase.rpc("design_director_action", {
      p_subtask_id: subtaskId,
      p_from_user: req.user.id,
      p_action: action, // 'approve' | 'revise'
      p_comment: comment,
    });

    if (error) throw error;
    return res.status(201);
  } catch (err) {
    console.error("[Design] Director action failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
