const {
  exchangeCodeForTokens,
  getConfig,
  saveIntegrationState,
} = require('./_lib');

function buildReturnUrl(success, message) {
  const { appBaseUrl } = getConfig();
  if (!appBaseUrl) return null;
  const url = new URL('/', appBaseUrl.startsWith('http') ? appBaseUrl : `https://${appBaseUrl}`);
  url.searchParams.set('calendar', success ? 'connected' : 'error');
  if (message) url.searchParams.set('message', message);
  return url.toString();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, error } = req.query;

  if (error) {
    const redirectUrl = buildReturnUrl(false, error);
    if (redirectUrl) return res.redirect(redirectUrl);
    return res.status(400).json({ error: 'Google Calendar authorisation was denied', detail: error });
  }

  if (!code) {
    return res.status(400).json({ error: 'Missing Google authorisation code' });
  }

  try {
    const tokenData = await exchangeCodeForTokens(code);
    const now = Date.now();
    await saveIntegrationState({
      connectedAt: new Date(now).toISOString(),
      refreshedAt: new Date(now).toISOString(),
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: new Date(now + (tokenData.expires_in || 3600) * 1000).toISOString(),
      scope: tokenData.scope,
      tokenType: tokenData.token_type || 'Bearer',
    });

    const redirectUrl = buildReturnUrl(true, 'google-calendar-connected');
    if (redirectUrl) return res.redirect(redirectUrl);

    return res.status(200).json({
      ok: true,
      message: 'Google Calendar connected',
    });
  } catch (err) {
    const redirectUrl = buildReturnUrl(false, 'google-calendar-connect-failed');
    if (redirectUrl) return res.redirect(redirectUrl);

    return res.status(500).json({
      error: 'Failed to complete Google Calendar authorisation',
      detail: err.message,
    });
  }
};
