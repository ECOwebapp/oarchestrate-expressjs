import {
  fetchTasks,
  fetchSubtasks,
  processDashboardTasks,
} from "../services/taskServices.js";
import { resolvePosUnitIds } from "../services/helperServices.js";
import express from "express";
const router = express.Router();

router.post("/", async (req, res) => {
  const { selectedMonth, selectedYear, CIRC } = req.body;

  try {
    const auth = await resolvePosUnitIds(req.supabase, req.user.id);
    let query = [fetchSubtasks(req.supabase, req.user.id)];

    if (!auth.isMember) {
      query.push(fetchTasks(req.supabase, req.user.id));
    }

    const [subtaskRes, taskRes] = await Promise.all(query);

    const items = [...(taskRes || []), ...(subtaskRes || [])];
    const result = {
      rawData: processDashboardTasks(
        items,
        auth,
        selectedMonth,
        selectedYear,
        CIRC,
      ),
      rawItems: items,
    };
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
