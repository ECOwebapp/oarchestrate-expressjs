import express from 'express';
import { selectAssigneeAssigner, TASK_SELECT, taskRow, resolveNames } from '../services/taskServices.js';
import { resolvePosUnitIds } from '../services/helperServices.js';
import { _notifySubmission } from '../services/notificationServices.js';
const router = express.Router()

// Tasks that are children of a PPA
router.get('/fetch', async (req, res) => {
  const { taskId, parentId } = req.query

  try {
    const { isDirector, isUnitHead } = await resolvePosUnitIds(req.supabase, req.user.id)
    const activeUnitHeadId = isUnitHead?.unit_id ?? null;

    let query = req.supabase.from('task').select(TASK_SELECT)
    if (parentId) query = query.eq('parent_ppa_id', Number(parentId));
    else if (taskId) query = query.eq('id', taskId)

    if (!isDirector) {
      if (isUnitHead) {
        // Unit Head: Sees their own tasks + anyone in their unit
        const { data: unitMembers } = await req.supabase
          .from("position")
          .select("user_id")
          .eq("unit_id", activeUnitHeadId);

        const allowedIds = [
          ...new Set([
            req.user.id,
            ...(unitMembers?.map((m) => m.user_id) || []),
          ]),
        ];
        query = query.in("assignee", allowedIds);
      } else {
        // Regular Member: ONLY sees tasks assigned to them
        query = query.eq("assignee", req.user.id);
      }
    }

    const { data: tasks, error } = await query.order("id", {
      ascending: false,
    });
    if (error) throw error;

    const formattedTasks = tasks.map((t) =>
      taskRow(t, activeUnitHeadId, req.user.id),
    );
    return res.status(200).json(formattedTasks);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
})

router.get('/fetch_revisions', async (req, res) => {
  const { taskId } = req.query
  try {
    const { data } = await req.supabase
      .from('task_revision')
      .select(`
        id, 
        task_id, 
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
        `)
      .eq('task_id', taskId)
      .order('created_at', { ascending: true })

    const unread = (data || []).filter(r => r.to_user === req.user.id && !r.is_read).map(r => r.id)
    if (unread.length) {
      await req.supabase.from('task_revision').update({ is_read: true }).in('id', unread)
    }

    return (data || []).map(r => ({
      ...r,
      fromName: resolveNames[r.fromName],
    }))

  } catch (err) {
    console.log('Error fetching revisions: ', err.message)
    return res.status(500).json({ error: err.message })
  }
})

router.post('/upsert', async (req, res) => {
  const { mainTask } = req.body

  try {
    // 1. Resolve Requester Roles & Units
    const { isDirector, isMember } = await resolvePosUnitIds(req.supabase, req.user.id)

    // 2. Determine Assignee
    // If they are a member, they can only assign to themselves.
    const assigneeId = isMember ? req.user.id : (mainTask.assignee || req.user.id);

    // 3. Prepare the Base Task Data
    const taskData = {
      parent_ppa_id: mainTask.parentId,
      assigner: mainTask.assignee ? req.user.id : null,
      assignee: mainTask.assignee ? assigneeId : null,
      design: !!mainTask.design
    };
    if (mainTask.id) taskData.id = mainTask.id;

    // 4. Execute Main Task Upsert
    const { data: taskRow, error: taskErr } = await req.supabase
      .from('task')
      .upsert(taskData, { onConflict: 'id' })
      .select('id').single();

    if (taskErr) throw taskErr;
    const taskId = taskRow.id;

    // 5. Approval Logic (Business Rules)
    const { unitId } = await resolvePosUnitIds(req.supabase, assigneeId)

    const assigneeUnits = unitId?.map(u => u.unit_id) || [];
    const isOfficeMember = assigneeUnits.includes(3); // Assuming 3 is Office

    const isSelfAssigned = assigneeId === req.user.id;
    const isDirectorSelfAssign = isDirector && isSelfAssigned;
    const hasOutput = !!mainTask.outputLink;

    let initialUnitHead = false;
    let initialDirector = false;

    if (isDirectorSelfAssign) {
      initialUnitHead = true;
      initialDirector = true;
    } else if ((isSelfAssigned && mainTask.type === 2) || (hasOutput && isOfficeMember)) {
      initialUnitHead = true;
    }

    // 6. Bulk Upsert Metadata
    // We use Promise.all to hit the related tables in parallel
    const upserts = [
      req.supabase.from('task_profile').upsert({
        task_id: taskId, title: mainTask.name, description: mainTask.description,
        task_type: mainTask.type, urgent: !!mainTask.urgent,
      }, { onConflict: 'task_id' }),
      req.supabase.from('task_approval').upsert({
        task_id: taskId, unit_head: initialUnitHead, director: initialDirector,
      }, { onConflict: 'task_id' }),
      req.supabase.from('task_duration').upsert({
        task_id: taskId, deadline: mainTask.endDate,
      }, { onConflict: 'task_id' })
    ];

    if (hasOutput) {
      upserts.push(req.supabase.from('task_output').upsert({
        task_id: taskId, link: mainTask.outputLink
      }, { onConflict: 'task_id' }));
    }

    await Promise.all(upserts);

    // 7. Notification Logic
    // In Express, you can trigger this and NOT await it if you want to speed up the response
    if (hasOutput && !isDirectorSelfAssign || mainTask.assignee) {
      // Assuming _notifySubmission is a helper function in your backend
      await _notifySubmission(taskId, assigneeId, req.user.id, null, isSelfAssigned);
    }

    return res.status(200);

  } catch (err) {
    console.log('Error adding tasks: ', err.message)
    return res.status(500).json({ error: err.message })
  }
})

router.post('/delete', async (req, res) => {
  const { taskIds } = req.body
  try {
    const { isDirector, isUnitHead, isMember } = await resolvePosUnitIds(req.supabase, req.user.id)

    if (isMember) throw new Error('You do not have permission to delete tasks.')

    let allowedIds = [...taskIds]
    if (isUnitHead && !isDirector) {
      const { data: validTasks, error } = await req.supabase
        .from('task')
        .select('id')
        .in('id', taskIds)
        .eq('assigner', req.user.id);

      if (error) throw error;

      // Map the results to get the IDs that actually matched
      allowedIds = validTasks.map(t => t.id);

      if (allowedIds.length === 0) return res.status(403).json({ error: 'You can only delete tasks that you assigned.' })

      // Optional: If you want to block the whole operation if even ONE ID is unauthorized:
      if (allowedIds.length !== taskIds.length) return res.status(403).json({ error: 'Unauthorized: Some tasks were not assigned by you.' });
    }

    let result
    const del = async (table, column, ids) => {
      if (!ids.length) return
      let query = req.supabase.from(table).delete().in(column, ids)
      if (table === 'task') {
        query = query.select()
      }
      const { data, error } = await query
      if (error) throw new Error(`[deleteTasks]: ${table} | ${error.message}`)
      if (table === 'task') result = data
    }

    await Promise.all([
      del('task_revision', 'task_id', allowedIds),
      del('task_poke', 'task_id', allowedIds),
      del('comment_section', 'task_id', allowedIds),
      del('task_notif', 'task_id', allowedIds),
      del('task_output', 'task_id', allowedIds),
      del('task_approval', 'task_id', allowedIds),
      del('task_duration', 'task_id', allowedIds),
      del('task_profile', 'task_id', allowedIds),
      del('task', 'id', allowedIds)
    ])

    return res.status(200).json({ result })

  } catch (err) {
    console.log('Error deleting tasks: ', err.message)
    return res.status(500).json({ error: err.message })
  }
})

router.post('/approve', async (req, res) => {
  const { taskId, role } = req.body

  try {
    const { data: task } = await req.supabase
      .from('task')
      .select('design, assignee')
      .eq('id', taskId)

    if (!task) throw new Error('Task not found')

    // Handle design task approvals
    if (task.design) {
      const designApprovalUpdate = {}
      let approvalMessage = ''

      if (role === 'senior_draftsman') {
        designApprovalUpdate.senior_draftsman = true
        approvalMessage = '✅ Design approved by Senior Draftsman — forwarded to Engineers.'
      } else if (role === 'engineers') {
        designApprovalUpdate.engineers = true
        approvalMessage = '✅ Design approved by Engineer — forwarded to Unit Head.'
      } else if (role === 'unit_head') {
        designApprovalUpdate.unit_head = true
        approvalMessage = '✅ Design approved by Unit Head — forwarded to Director.'
      } else if (role === 'director') {
        designApprovalUpdate.director = true
        approvalMessage = '✅ Design fully approved by Director.'
      }

      // Update design_approval table (using id from subtask relationship if exists)
      const [{ error: updateErr }, { error: revisionErr }] = await Promise.all([
        req.supabase
          .from('design_approval')
          .update(designApprovalUpdate)
          .eq('id', taskId),
        req.supabase.from('task_revision').insert({
          task_id: taskId,
          from_user: req.user.id,
          to_user: task.assignee,
          role,
          comment: approvalMessage,
          is_read: false,
        })
      ])

      if (updateErr) throw new Error(updateErr.message)
      if (revisionErr) throw new Error(revisionErr.message)

    } else {
      // Handle regular task approvals
      const col = role === 'director' ? 'director' : 'unit_head'
      const [{ error: updateErr }, { error: revisionErr }] = await Promise.all([
        req.supabase
          .from('task_approval')
          .update({ [col]: true, revision_comment: null, revised_at: null })
          .eq('task_id', taskId),

        req.supabase.from('task_revision').insert({
          task_id: taskId,
          from_user: req.user.id,
          to_user: task.assignee,
          role,
          comment: role === 'director'
            ? '✅ Task fully approved by Director.'
            : '✅ Task approved by Unit Head — forwarded to Director.',
          is_read: false,
        })
      ])

      if (updateErr) throw new Error(updateErr.message)
      if (revisionErr) throw new Error(revisionErr.message)
    }

    return res.status(204)

  } catch (err) {
    console.log('Error approving task: ', err.message)
    return res.status(500).json({ error: err.message })
  }
})

router.post('/revision_request', async (req, res) => {
  const { taskId, comment, role } = req.body

  try {
    const { data: task } = await req.supabase
      .from('task')
      .select('design, assignee')
      .eq('id', taskId)

    if (!task) throw new Error('Task not found')

    if (task.design) {
      // For design tasks, reset the relevant approval flag based on the role
      const designResetCols = {}

      if (role === 'director') {
        // Director resets all flags
        designResetCols.senior_draftsman = false
        designResetCols.engineers = false
        designResetCols.unit_head = false
        designResetCols.director = false
      } else if (role === 'unit_head') {
        // Unit head resets from engineers onwards
        designResetCols.engineers = false
        designResetCols.unit_head = false
      } else if (role === 'engineers') {
        // Engineers reset themselves
        designResetCols.engineers = false
      }

      await Promise.all([
        supabase.from('task_profile').update({ revision: true }).eq('task_id', taskId),
        supabase.from('task_revision').insert({
          task_id: taskId,
          from_user: req.user.id,
          to_user: task.assignee,
          role,
          comment,
          is_read: false,
        })
      ])
    } else {
      // Regular task revision logic
      const resetCols = role === 'director'
        ? { unit_head: false, director: false, revision_comment: comment, revised_at: new Date().toISOString() }
        : { unit_head: false, revision_comment: comment, revised_at: new Date().toISOString() }

      await Promise.all([
        supabase.from('task_approval').update(resetCols).eq('task_id', taskId),
        supabase.from('task_profile').update({ revision: true }).eq('task_id', taskId),
        supabase.from('task_revision').insert({
          task_id: taskId,
          from_user: req.user.id,
          to_user: task.assignee,
          role,
          comment,
          is_read: false,
        })
      ])
    }

    return res.status(204)

  } catch (err) {
    console.log('Error requesting revision: ', err.message)
    return res.status(500).json({ error: err.message })
  }
})

router.post('/resubmit', async (req, res) => {
  const { taskId, newOutputLink } = req.body

  try {
    const { data: task } = await req.supabase
      .from('task')
      .select('assignee')
      .eq('id', taskId)

    if (!task) throw new Error('Task not found')

    if (newOutputLink) {
      const { data: updated, error: updErr } = await req.supabase
        .from('task_output').update({ link: newOutputLink }).eq('task_id', taskId).select('id')
      if (updErr) throw new Error(updErr.message)
      if (!updated || updated.length === 0) {
        const { error: insErr } = await supabase
          .from('task_output').insert({ task_id: taskId, link: newOutputLink })
        if (insErr) throw new Error(insErr.message)
      }
    }

    const [{ data: lastRevision }, []] = await Promise.all([
      req.supabase
        .from('task_revision')
        .select('role, from_user')
        .eq('task_id', taskId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

      req.supabase
        .from('task_profile')
        .update({ revision: false })
        .eq('task_id', taskId)
    ])

    const revisorRole = lastRevision?.role || 'unit_head'
    const assigneeId = task?.assignee || req.user.id

    if (revisorRole === 'director') {
      await req.supabase.from('task_approval')
        .update({ unit_head: true, director: false, revision_comment: null, revised_at: null })
        .eq('task_id', taskId)

      if (lastRevision?.from_user) {
        await req.supabase.from('task_revision').insert({
          task_id: taskId,
          from_user: req.user.id,
          to_user: lastRevision.from_user,
          role: 'director',
          comment: '📎 Revised output resubmitted — awaiting your final approval.',
          is_read: false,
        })
      }
      await req.supabase.from('task_notif').upsert(
        { task_id: taskId, read_by_director: false, read_by_assignee: true, read_by_unit_head: true },
        { onConflict: 'task_id' }
      )
    } else {
      const { isOfficeMember } = await resolvePosUnitIds(req.supabase, assigneeId)
      const assignerData = await selectAssigneeAssigner(req.supabase, taskId)
      const isSelfAssigned = assignerData?.assigner === assigneeId

      if (isOfficeMember || isSelfAssigned) {
        await req.supabase.from('task_approval')
          .update({ unit_head: true, revision_comment: null, revised_at: null })
          .eq('task_id', taskId)
      } else {
        await req.supabase.from('task_approval')
          .update({ revision_comment: null, revised_at: null })
          .eq('task_id', taskId)
      }

      await _notifySubmission(
        taskId, assigneeId, req.user.id,
        '📎 Revised output resubmitted — awaiting your review.',
        isSelfAssigned
      )
    }
  } catch (err) {
    console.log('Error resubmiting: ', err.message)
    return res.status(500).json({ error: err.message })
  }
})
