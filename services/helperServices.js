export const resolvePosUnitIds = async (supabase, userId = null, unitId = null) => {
  let query = supabase
    .from('position')
    .select('user_id, unit_id, pos_id')

  if (userId) query = query.eq('user_id', userId);
  else if(unitId) query = query.eq('unit_id', unitId)
  else query = query.in('pos_id', [1, 4])

  const { data: userData } = await query

  const unitMembers = unitId ? userData.user_id : null
  const userUnitId = userData.unit_id // Unit ID of the User
  const directorId = userId ? null : userData.filter(p => p.pos_id === 1)?.user_id
  const allUnitHeads = () => {
    if (userId) return []
    return userData.filter(link => link.pos_id === 4)
  }

  // Boolean variables
  const isDirector = userData?.some(p => p.pos_id === 1);
  const isUnitHead = userData?.some(p => p.pos_id === 4);
  const isOfficeMember = userData?.some(p => p.unit_id === 3)
  const isMember = !isDirector && !isUnitHead // Simplified check

  return {
    isDirector,
    isUnitHead,
    isMember,
    isOfficeMember,
    userUnitId,
    directorId,
    unitMembers,
    allUnitHeads
  }
}