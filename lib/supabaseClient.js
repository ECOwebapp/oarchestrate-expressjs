import { createServerClient } from '@supabase/ssr'
import 'dotenv/config'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseAnonKey = process.env.SUPABASE_PUBLISHABLE_KEY

// 1. Standard client
export const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
        getAll() { return [] },
        setAll() { },
    }
})

// 2. Helper to create a client that "acts as" a specific user
export const createSupabaseUserClient = (token) => {
    return createServerClient(supabaseUrl, supabaseAnonKey, {
        // COOKIES should be here (top level)
        cookies: {
            getAll() { return [] },
            setAll() { },
        },
        // GLOBAL should be here (top level)
        global: {
            headers: { Authorization: `Bearer ${token}` },
        },
    })
}
