import { supabase, tempSupabaseClient } from "../lib/supabaseClient.js";
import express from "express";
import { fetchUserData } from "../services/authServices.js";
import { verifyToken } from "../middleware/verifyToken.js";
const router = express.Router();

const isProd = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
const cookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? "none" : "lax",
  path: "/",
};

if (isProd) cookieOptions.partitioned = true;

// Change to POST for security and body access
router.post("/login", async (req, res) => {
  // Access data from req.body instead of headers
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }
  const internalEmail = email.trim().toLowerCase();
  // const internalEmail = `${idNumber
  //   .trim()
  //   .toLowerCase()
  //   .replace(/[^a-z0-9]/g, "-")}@carsu.edu.ph`;

  try {
    // 1. Attempt Sign In
    const { data: authData, error: authErr } =
      await supabase.auth.signInWithPassword({
        email: internalEmail,
        password: password,
      });

    if (authErr) {
      return res.status(401).json({ error: authErr.message });
    }

    const userId = authData.user?.id;

    // 2. Check account_status (Your specific office logic)
    const { data: statusData, error: statusErr } = await supabase
      .from("account_status")
      .select("status_id, notes")
      .eq("user_id", userId)
      .single();

    if (statusErr) console.log("Failed to check status: ", statusErr);

    const status = statusData?.status_id;

    // Status 1 = Pending, Status 3 = Blocked/Suspended
    if (status === 1 || status === 3) {
      await supabase.auth.signOut();
      return res.status(403).json({
        status_id: status,
        notes: statusData?.notes,
      });
    }

    // 3. Success - Fetch extra user data
    // Assume fetchUserData is a helper function you've defined
    const userData = await fetchUserData(supabase, userId);

    res.cookie("access_token", authData.session.access_token, {
      ...cookieOptions,
      maxAge: 86400000, // 24 hours
    });

    return res.status(200).json({
      userId,
      access_token: authData.session.access_token,
      userData: userData,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/register", async (req, res) => {
  const { form, fullAddress } = req.body;
  try {
    if (!/^[a-zA-Z0-9._%+-]+@carsu\.edu\.ph$/.test(form.email))
      throw new Error("Only accepts CarSU email");

    const internalEmail = form.email.trim().toLowerCase();

    // const internalEmail = `${form.email
    //   .trim()
    //   .toLowerCase()
    //   .replace(/[^a-z0-9]/g, "-")}@carsu.edu.ph`;

    // 1. Create auth user
    const { data: authData, error: authErr } = await supabase.auth.signUp({
      email: internalEmail,
      password: form.password,
    });
    if (authErr) throw authErr;

    const userId = authData.user?.id;
    if (!userId) throw new Error("No user ID returned.");

    // 2. UPSERT user_profile first — must exist before member_type FK resolves
    const { error: profErr } = await supabase.from("user_profile").upsert({
      user_id: userId, // ✅ PK is user_id
      fname: form.firstName.trim(),
      lname: form.lastName.trim(),
      middle_initial: form.middleInitial.trim() || null,
      birthdate: form.birthdate || null,
      gender_id: form.genderId ? parseInt(form.genderId) : null,
      id_number: form.idNumber.trim(),
    });
    if (profErr) throw new Error(`Profile error: ${profErr.message}`);

    // 3. Now insert everything else in parallel — user_profile row exists so FKs resolve
    const [contactRes, addressRes, statusRes] = await Promise.all([
      supabase.from("email").upsert({
        user_id: userId,
        email_address: internalEmail,
      }),

      supabase.from("address").upsert({
        user_id: userId,
        address: fullAddress,
        region_code: form.regionCode || null,
        province_code: form.provinceCode || null,
        city_code: form.cityCode || null,
        barangay_code: form.barangayCode || null,
      }),

      supabase.from("account_status").upsert({
        user_id: userId,
        requested_at: new Date().toISOString(),
      }),
    ]);

    // Surface any errors so they're not silently swallowed
    const errs = [
      contactRes.error && `Contact: ${contactRes.error.message}`,
      addressRes.error && `Address: ${addressRes.error.message}`,
      // positionRes.error && `Position: ${positionRes.error.message}`,
      statusRes.error && `Account status: ${statusRes.error.message}`,
    ].filter(Boolean);

    if (errs.length) {
      // Log all but only throw the first so the user sees a message
      errs.forEach((e) => console.error("[Register]", e));
      throw new Error(errs[0]);
    }

    return res.status(201);
  } catch (e) {
    console.log("Error registration: ", e.message);
    return res.status(500).json({ error: e.message });
  }
});

router.get("/state", async (req, res) => {
  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_IN" && session?.user) {
      return res.status(200);
    } else if (event === "SIGNED_OUT") {
      return res.status(401);
    }
  });
});

router.post("/logout", verifyToken, async (req, res) => {
  // This tells Supabase to invalidate the session/token immediately
  const { error } = await req.supabase.auth.signOut();

  if (error) return res.json({ error: error.message });
  res.clearCookie("access_token", {
    ...cookieOptions,
  });
  return res.status(200).json({ message: "Logged out successfully" });
});

router.get("/me", verifyToken, async (req, res) => {
  try {
    // req.user was attached by verifyToken middleware
    const userData = await fetchUserData(req.supabase, req.user.id);

    return res.status(200).json({
      userData: userData,
      user_id: req.user.id,
    });
  } catch (err) {
    console.log("Failed to fetch user data: ", err);
    return res.status(500).json({ error: err.message });
  }
});

// Requires testing when internet connection returns
// >> Hexer <<
router.post("/pass", verifyToken, async (req, res) => {
  const { payload, status } = req.body || {};
  const token = req.cookies?.access_token;

  try {
    if (!status || !payload?.password) {
      return res.status(400).json({ error: "Missing password request data" });
    }

    if (status === "verify") {
      if (!req.user?.email) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { error } = await supabase.auth.signInWithPassword({
        email: req.user.email,
        password: payload.password,
      });
      if (error) {
        return res.status(400).json({ error: error.message || "Current password is incorrect" });
      }

      return res.status(200).json({ message: "Password verified" });
    } else if (status === "change") {
      if (!req.user?.email) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const newPassword = payload?.password;
      const currentPassword = payload?.currentPassword;

      if (!newPassword) {
        return res.status(400).json({ error: "New password is required" });
      }

      // Create a temp client and establish a session by re-authenticating
      const tempClient = tempSupabaseClient(token || "");
      
      // Step 1: Re-auth to establish session on this client instance
      const { data: authData, error: reauthError } =
        await tempClient.auth.signInWithPassword({
          email: req.user.email,
          password: currentPassword,
        });

      if (reauthError) {
        return res.status(400).json({ error: "Current password is incorrect" });
      }

      // Step 2: Now that session is established, call updateUser on same client
      const { error: updateError } = await tempClient.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        return res.status(400).json({ error: updateError.message || "Unable to update password" });
      }

      return res.status(200).json({ message: "Password updated" });
    }

    return res.status(400).json({ error: "Unsupported password action" });
  } catch (err) {
    console.log("Failed to update password: ", err?.message || err);
    return res.status(500).json({ error: "Password endpoint failed" });
  }
});

export default router;
