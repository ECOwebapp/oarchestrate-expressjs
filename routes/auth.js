import { supabase } from "../lib/supabaseClient.js";
import express from 'express';
import { fetchUserData } from '../services/authServices.js'
import { verifyToken } from "../middleware/verifyToken.js";
const router = express.Router();

// Change to POST for security and body access
router.post('/login', async (req, res) => {
    // Access data from req.body instead of headers
    const { idNumber, password } = req.body;

    if (!idNumber || !password) {
        return res.status(400).json({ error: "Missing credentials" });
    }

    const internalEmail = `${idNumber.trim().toLowerCase().replace(/[^a-z0-9]/g, '-')}@carsu.edu.ph`;

    try {
        // 1. Attempt Sign In
        const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
            email: internalEmail,
            password: password,
        });

        if (authErr) {
            return res.status(401).json({ error: authErr.message });
        }

        const userId = authData.user?.id;

        // 2. Check account_status (Your specific office logic)
        const { data: statusData, error: statusErr } = await supabase
            .from('account_status')
            .select('status_id, notes')
            .eq('user_id', userId)
            .single();

        if (statusErr) console.log('Failed to check status: ', statusErr)

        const status = statusData?.status_id;

        // Status 1 = Pending, Status 3 = Blocked/Suspended
        if (status === 1 || status === 3) {
            await supabase.auth.signOut();
            return res.status(403).json({
                status_id: status,
                notes: statusData?.notes
            });
        }

        // 3. Success - Fetch extra user data
        // Assume fetchUserData is a helper function you've defined
        const userData = await fetchUserData(supabase, userId);

        res.status(200).json({
            userData: userData,
            session: authData.session
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

router.get('/state', async (req, res) => {
    supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_IN' && session?.user) {
            res.status(200)
        }
        else if (event === 'SIGNED_OUT') {
            res.status(401)
        }
    })
})

router.post('/logout', verifyToken, async (req, res) => {

    // This tells Supabase to invalidate the session/token immediately
    const { error } = await req.supabase.auth.signOut();

    if (error) res.json({ error: error.message })
    res.status(200).json({ message: 'Logged out successfully' });
})

router.get('/me', verifyToken, async (req, res) => {
    try {
        // req.user was attached by verifyToken middleware
        const userData = await fetchUserData(req.supabase, req.user.id);

        res.status(200).json({
            userData: userData,
            user_id: req.user.id
        });
    } catch (err) {
        console.log("Failed to fetch user data: ", err);
    }
});

export default router;