import express from 'express';
const router = express.Router();

router.get('/fetch', async(req, res) => {
    try {
        const { data: projectRes, error: projectErr, status } = await req.supabase.rpc('get_ppa', { user_uuid: req.user.id })

        if (projectErr) throw new Error(projectErr)

        const projects = (projectRes || []).map(p => ({
            ...p,
            director: p.director
                ? `${p.director.fname} 
                    ${p.director.middle_initial !== null ? p.director.middle_initial : ''} 
                    ${p.director.lname}`
                : null,
        }))

        return res.status(status || 200).json({ projects: projects })

    } catch(err){
        console.log('Error fetching PPAs: ', err.message)
        return res.status(500).json({error: err.message })
    }
})

export default router