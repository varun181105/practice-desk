function authError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isWorkspaceOAuthRequired(supabaseUrl, nodeEnv) {
  return Boolean(supabaseUrl) || nodeEnv === 'production';
}

async function authorizeWorkspaceUser(supabaseClient, accessToken) {
  if (!accessToken) throw authError(401, 'Sign in with Google to continue.');

  const { data, error } = await supabaseClient.auth.getUser(accessToken);
  const user = data && data.user;
  if (error || !user) throw authError(401, 'Your sign-in session is invalid or expired.');

  const email = String(user.email || '').trim().toLowerCase();
  if (!email || !(user.email_confirmed_at || user.confirmed_at)) {
    throw authError(403, 'Access Restricted. Contact Administrator.');
  }

  const { data: tenant, error: tenantError } = await supabaseClient
    .from('authorized_tenants')
    .select('email, practice_name')
    .eq('email', email)
    .eq('is_active', true)
    .maybeSingle();

  if (tenantError) throw authError(503, 'Workspace authorization is temporarily unavailable.');
  if (!tenant) throw authError(403, 'Access Restricted. Contact Administrator.');

  return {
    caId: user.id,
    email,
    practiceName: tenant.practice_name || ''
  };
}

module.exports = { authorizeWorkspaceUser, isWorkspaceOAuthRequired };