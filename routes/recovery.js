import express from "express";
import { supabase, tempSupabaseClient } from "../lib/supabaseClient.js";
const router = express.Router();

router.post("/request-otp", async (req, res) => {
  const { email } = req.body;
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email);

    if (error) throw error;
    return res.status(200).send("OTP sent to your email");
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

router.post("/verify-and-reset", async (req, res) => {
  const { email, token, newPassword } = req.body;

  try {
    if (!/^[a-zA-Z0-9._%+-]+@carsu\.edu\.ph$/.test(email))
      throw new Error("Only accepts CarSU email");
    // 1. Verify OTP - This creates a session in THIS specific client instance
    const { data, error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token,
      type: "recovery",
    });

    if (verifyError) throw verifyError;

    // 2. IMPORTANT: The 'data.session.access_token' is now live.
    // Because we are using the SAME 'supabase' instance for the next line,
    // the internal memory already knows the session is active.
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (updateError) throw updateError;

    return res.status(200).send("Password reset successfully!");
  } catch (e) {
    return res.status(401).send(e.message);
  }
});

export default router;
