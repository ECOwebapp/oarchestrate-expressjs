import express from "express";
const router = express.Router();

router.get("/fetch", async (req, res) => {
  try {
    const {
      data: projectRes,
      error: projectErr,
      status,
    } = await req.supabase.rpc("get_ppa", { user_uuid: req.user.id });
    if (projectErr) throw new Error(projectErr);

    const isInsertionProject = (item) =>
      item.type?.toLowerCase() === "insertion" ||
      item.typeId === 2 ||
      item.isInsertion === true ||
      item.is_insertion === true;

    const projects = (projectRes || [])
      .filter((p) => p.is_involved !== false && !isInsertionProject(p))
      .map((p) => ({
        ...p,
        director: p.director
          ? `${p.director.fname}
                    ${p.director.middle_initial !== null ? p.director.middle_initial : ""}
                    ${p.director.lname}`
          : null,
      }));

    return res.status(200).json({ projects: projects });
  } catch (err) {
    console.log("Error fetching PPAs: ", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/insert", async (req, res) => {
  const { title, description, deadline } = req.body;
  try {
    const {
      data: projectRes,
      error: projectErr,
      status,
    } = await req.supabase
      .from("ppa")
      .insert({
        name: title,
        description: description,
        deadline: deadline,
        director_id: req.user.id,
      })
      .select();

    if (projectErr) throw new Error(projectErr);

    return res.status(status || 200);
  } catch (e) {
    console.log("Failed to insert PPAs: ", e.message);
    return res.status(500).json({ erroor: e.message });
  }
});

router.post("/update", async (req, res) => {
  const { project } = req.body;
  try {
    const {
      data: projectRes,
      error: projectErr,
      status,
    } = await req.supabase
      .from("ppa")
      .update({ project })
      .eq("id", project.id)
      .select();

    if (projectErr) throw new Error(projectErr);

    return res.status(status || 200);
  } catch (e) {
    console.log("Failed to update PPAs: ", e.message);
    return res.status(500).json({ erroor: e.message });
  }
});

router.post("/delete", async (req, res) => {
  const { id } = req.body;
  try {
    const { error: projectErr, status: projectStatus } = await req.supabase
      .from("ppa")
      .delete()
      .in("id", id);

    if (projectErr) throw new Error(projectErr);

    return res.status(projectStatus || 204);
  } catch (e) {
    console.log("Failed to delete PPAs: ", e.message);
    return res.status(500).json({ erroor: e.message });
  }
});

export default router;
