// Determines all positions of a user or user IDs of Director or Unit Head
export const resolvePosUnitIds = async (supabase, userId = null, unitId = null) => {
  let query = supabase
    .from('position')
    .select('user_id, unit_id, pos_id')

  if (userId) query = query.eq('user_id', userId);
  else if (unitId) query = query.eq('unit_id', unitId)
  else query = query.in('pos_id', [1, 4])

  const { data: userData } = await query

  const unitMembers = unitId ? userData.map(u => u.user_id) : []
  const userUnitId = userData.map(u => u.unit_id) || [];
  const directorId = userId ? null : userData.filter(p => p.pos_id === 1)?.user_id
  const allUnitHeads = () => {
    if (userId) return []
    return userData.filter(link => link.pos_id === 4)
  }

  // The Unit ID where a Unit Head is currently in.
  // Remove or replace this if other variables already performed the same function.
  const activeUnitId = userData.filter(p => p.pos_id === 4).unit_id

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
    allUnitHeads,
    activeUnitId
  }
}

export const resolvePosUnitNames = async (supabase, userIds = []) => {
  const { data, error } = await supabase.from('position')
    .select(`
      user_id, 
      pos_name:position_pos_id_fkey(pos_name),
      unit:position_unit_id_fkey(name)
    `)
    .in('user_id', userIds);

  if (error) return {};

  // Create a single map: { [userId]: { pos: '...', unit: '...' } }
  return Object.fromEntries(
    data.map(item => [
      item.user_id,
      {
        pos: item.pos_name?.pos_name || '',
        unit: item.unit?.name || ''
      }
    ])
  );
};