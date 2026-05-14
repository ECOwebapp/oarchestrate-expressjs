import { tempSupabaseClient } from "../lib/supabaseClient.js";

const decodeJwtPayload = (token) => {
  try {
    const payload = token?.split(".")?.[1];
    if (!payload) return null;

    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "==".slice((normalized.length + 2) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
};

export const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization || req.query.token;
    const token = req.cookies.access_token
  
    const bearerToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;
    const authToken = token || bearerToken;

    if (!authToken) return res.status(401).json({ error: 'Unauthorized' });
    if (req.path === '/webhook' || req.method === 'OPTIONS') {
      return next();
  }
  
    try {
      // Verify the token directly, without relying on an implicit client session.
      const userSupabase = tempSupabaseClient(authToken);
      const { data: { user }, error } = await userSupabase.auth.getUser(authToken);
  
      if (error || !user) {
        const decoded = decodeJwtPayload(authToken);
        if (!decoded?.sub) {
          return res.status(401).json({ error: 'Invalid token' });
        }

        req.supabase = userSupabase;
        req.user = {
          id: decoded.sub,
          email: decoded.email,
        };
        return next();
      }
  
      // Attach the client and user to the request for your routes to use
      req.supabase = userSupabase; 
      req.user = user;
      next();
    } catch (err) {
      console.log(err)
      return res.status(401).json({ error: 'Authentication fail' });
    }
};
