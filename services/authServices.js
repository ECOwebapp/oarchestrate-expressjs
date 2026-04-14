export const fetchUserData = async (supabase, authUserId) => {
    if (!authUserId) return

    const [profRes, posRes, statusRes] = await Promise.all([
        supabase
            .from('user_profile')
            .select(`
                user_id,
                lname,
                fname,
                middle_initial,
                birthdate,
                gender_id,
                avatar_url,
                contact(phone),
                email(email_address),
                gender:gender_type(gender),
                address:address(
                    region_code,
                    province_code,
                    city_code,
                    barangay_code
                )
            `)
            .eq('user_id', authUserId)
            .maybeSingle(),

        supabase
            .from('position')
            .select('pos_id, unit_id, position_name(pos_name), unit_name(name)')
            .eq('user_id', authUserId),

        supabase
            .from('account_status')
            .select('status_id')
            .eq('user_id', authUserId)
            .maybeSingle(),
    ])

    if (profRes.error) console.error('[auth] members:', profRes.error.message)
    if (posRes.error) console.error('[auth] position:', posRes.error.message)
    if (statusRes.error) console.error('[auth] account_status:', statusRes.error.message)

    let profile = null
    if (profRes.data) {
        const { gender, address, contact, email, ...rest } = profRes.data
        profile = {
            ...rest,
            gender: gender?.gender,
            contact: contact?.map(p => p.phone) || [],
            email_address: email?.map(e => e.email_address) || [],
            region_code: address?.region_code || '',
            province_code: address?.province_code || '',
            city_code: address?.city_code || '',
            barangay_code: address?.barangay_code || ''
        }
    }

    return {
        profile: profile || null,
        positions: posRes.data.map(p => ({
            ...p,
            pos_name: p.position_name?.pos_name,
            unit_name: p.unit_name?.name
        })) || [],
        accountStatus: statusRes.data?.status_id ?? 1,
    };

}