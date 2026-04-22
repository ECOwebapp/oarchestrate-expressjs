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

        res.cookie('access_token', authData.session.access_token, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            maxAge: 86400000, // 24 Hours,
            partitioned: true,
            path: '/'
        })

        return res.status(200).json({
            userId,
            userData: userData,
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

router.post('/register', async (req, res) => {
    const { form, fullAddress } = req.body
    try {
        const internalEmail = `${form.idNumber.trim().toLowerCase().replace(/[^a-z0-9]/g, '-')}@carsu.edu.ph`

        // 1. Create auth user
        const { data: authData, error: authErr } = await supabase.auth.signUp({
            email: internalEmail,
            password: form.password,
        })
        if (authErr) throw authErr

        const userId = authData.user?.id
        if (!userId) throw new Error('No user ID returned.')

        // 2. UPSERT user_profile first — must exist before member_type FK resolves
        const { error: profErr } = await supabase
            .from('user_profile')
            .upsert({
                user_id: userId,          // ✅ PK is user_id
                fname: form.firstName.trim(),
                lname: form.lastName.trim(),
                middle_initial: form.middleInitial.trim() || null,
                birthdate: form.birthdate || null,
                gender_id: form.genderId ? parseInt(form.genderId) : null,
                id_number: form.idNumber.trim(),
            })
        if (profErr) throw new Error(`Profile error: ${profErr.message}`)

        // 3. Now insert everything else in parallel — user_profile row exists so FKs resolve
        const [
            contactRes,
            addressRes,
            statusRes,
        ] = await Promise.all([
            supabase.from('contact').upsert({
                user_id: userId,
                phone: form.phone.trim(),
            }),

            supabase.from('address').upsert({
                user_id: userId,
                address: fullAddress,
                region_code: form.regionCode || null,
                province_code: form.provinceCode || null,
                city_code: form.cityCode || null,
                barangay_code: form.barangayCode || null,
            }),

            supabase.from('account_status').upsert({
                user_id: userId,
                requested_at: new Date().toISOString(),
            }),
        ])

        // Surface any errors so they're not silently swallowed
        const errs = [
            contactRes.error && `Contact: ${contactRes.error.message}`,
            addressRes.error && `Address: ${addressRes.error.message}`,
            // positionRes.error && `Position: ${positionRes.error.message}`,
            statusRes.error && `Account status: ${statusRes.error.message}`,
        ].filter(Boolean)

        if (errs.length) {
            // Log all but only throw the first so the user sees a message
            errs.forEach(e => console.error('[Register]', e))
            throw new Error(errs[0])
        }

        return res.status(201)

    } catch (e) {
        console.log('Error registration: ', e.message)
        return res.status(500).json({ error: e.message })
    }
})

router.get('/state', async (req, res) => {
    supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_IN' && session?.user) {
            return res.status(200)
        }
        else if (event === 'SIGNED_OUT') {
            return res.status(401)
        }
    })
})

router.post('/logout', verifyToken, async (req, res) => {

    // This tells Supabase to invalidate the session/token immediately
    const { error } = await req.supabase.auth.signOut();

    if (error) return res.json({ error: error.message })
    res.clearCookie('access_token', {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        partitioned: true,
        path: '/'
    });
    return res.status(200).json({ message: 'Logged out successfully' });
})

router.get('/me', verifyToken, async (req, res) => {
    try {
        // req.user was attached by verifyToken middleware
        const userData = await fetchUserData(req.supabase, req.user.id);

        return res.status(200).json({
            userData: userData,
            user_id: req.user.id
        });
    } catch (err) {
        console.log("Failed to fetch user data: ", err);
        return res.status(500).json({ error: err.message })
    }
});


// Requires testing when internet connection returns
// >> Hexer <<
router.post('/pass', verifyToken, async (req, res) => {
    const { payload, status } = req.body
    try {
        if (status === 'verify') {
            payload.email = req.user.email
            const { error } = await req.supabase.auth.signInWithPassword(payload)
            if (error) throw new Error(error.message)

        } else if (status === 'change') {
            const { error } = await req.supabase.auth.updateUser(payload)
            if (error) throw new Error(error.message)
        }
        return res.status(204)

    } catch (err) {
        console.log('Failed to update password: ', err.message)
        return res.status(500).json({ error: err.message })
    }
})

export default router;