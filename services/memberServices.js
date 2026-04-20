export const fetchMembers = async(supabase) => {
    try {
        loading.value = true
        const [resMembers, resProf, resStatus] = await Promise.all([
            supabase.from('members').select('*'),
            supabase.from('profession').select('user_id, profession_name:prof_id(prof_name)'),
            supabase.from('account_status').select('user_id, status_id')
        ])

        // 2. Catch any of the 3 errors immediately
        const err = resMembers.error || resProf.error || resStatus.error
        if (err) throw err

        const profMap = Object.fromEntries(resProf.data.map(p => [p.user_id, p.profession_name?.prof_name]))
        const statusMap = Object.fromEntries(resStatus.data.map(s => [s.user_id, s.status_id]))

        if (resMembers) {
            return resMembers.data.map(m => ({
                id: m.user_id,
                lname: m.lname,
                fname: m.fname,
                middle_initial: m.middle_initial,
                birthdate: m.birthdate,
                contact: m.phone,
                email: m.email_address,
                gender: m.gender,
                avatar_url: m.avatar_url,
                // Instant lookups from our maps
                profession: profMap[m.user_id]?.trim() || '',
                status_id: statusMap[m.user_id]
            }))
        }
        // console.log(profRows)
        // console.log(members.value)

    } catch (e) {
        console.log('Failed to fetch members: ', e)
        throw new Error(e)
    } 
}

// Queries the raw `position` table (not the view) so ALL rows per user
// are returned — users with multiple positions are fully represented.
export const fetchMemberPos = async (supabase) => {
    try {
        const { data: posRows, error: posErr } = await supabase
            .from('position')
            .select('user_id, pos_id, unit_id')

        if (posErr) throw posErr

        return (posRows || []).map(p => ({
            user_id: p.user_id,
            pos_id:  p.pos_id,
            unit_id: p.unit_id,
        }))

    } catch (e) {
        console.log('Error: ', e)
        throw new Error(e)
    }
}