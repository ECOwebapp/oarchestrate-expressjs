import { createSupabaseUserClient } from "../lib/supabaseClient.js";

export const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization || req.query.token;
    const token = req.cookies.access_token
  
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    if (req.path === '/webhook' || req.method === 'OPTIONS') {
      return next();
  }
  
    try {
      // Initialize the scoped client using your new helper
      const userSupabase = createSupabaseUserClient(token);

      // Verify the user exists/token is valid
      const { data: { user }, error } = await userSupabase.auth.getUser();
  
      if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  
      // Attach the client and user to the request for your routes to use
      req.supabase = userSupabase; 
      req.user = user;
      next();
    } catch (err) {
      console.log(err)
      return res.status(401).json({ error: 'Authentication fail' });
    }
};
