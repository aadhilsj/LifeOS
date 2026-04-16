const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

function getEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getConfig() {
  return {
    googleClientId: getEnv('GOOGLE_CLIENT_ID'),
    googleClientSecret: getEnv('GOOGLE_CLIENT_SECRET'),
    googleRedirectUri: getEnv('GOOGLE_REDIRECT_URI'),
    supabaseUrl: getEnv('SUPABASE_URL'),
    supabaseServiceRoleKey: getEnv('SUPABASE_SERVICE_ROLE_KEY'),
    integrationRowId: process.env.KAIRO_DATA_ROW_ID || 'main',
    appBaseUrl: process.env.APP_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || '',
  };
}

function buildState() {
  return Buffer.from(JSON.stringify({
    nonce: Math.random().toString(36).slice(2, 10),
    createdAt: Date.now(),
  })).toString('base64url');
}

function buildGoogleAuthUrl() {
  const { googleClientId, googleRedirectUri } = getConfig();
  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: googleRedirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: GOOGLE_SCOPE,
    state: buildState(),
  });
  return `${GOOGLE_AUTH_BASE}?${params.toString()}`;
}

async function supabaseRequest(path, { method = 'GET', body } = {}) {
  const { supabaseUrl, supabaseServiceRoleKey } = getConfig();
  const preferHeader = method === 'POST'
    ? 'resolution=merge-duplicates,return=representation'
    : 'return=representation';
  const headers = {
    apikey: supabaseServiceRoleKey,
    'Content-Type': 'application/json',
    Prefer: preferHeader,
  };

  // Legacy service_role keys are JWTs and still work through Authorization.
  if (supabaseServiceRoleKey.startsWith('eyJ')) {
    headers.Authorization = `Bearer ${supabaseServiceRoleKey}`;
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase request failed (${response.status}): ${text}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function loadLifeOsRow() {
  const { integrationRowId } = getConfig();
  const rows = await supabaseRequest(`lifeos_data?id=eq.${encodeURIComponent(integrationRowId)}&select=id,data`);
  return rows?.[0] || null;
}

async function saveIntegrationState(nextIntegrationState) {
  const { integrationRowId } = getConfig();
  const existing = await loadLifeOsRow();
  const currentData = existing?.data && typeof existing.data === 'object' ? existing.data : {};
  const nextData = {
    ...currentData,
    integrations: {
      ...(currentData.integrations || {}),
      googleCalendar: nextIntegrationState,
    },
  };

  const rows = await supabaseRequest('lifeos_data', {
    method: 'POST',
    body: [{
      id: integrationRowId,
      data: nextData,
      updated_at: new Date().toISOString(),
    }],
  });

  return rows?.[0] || null;
}

async function getCalendarIntegration() {
  const row = await loadLifeOsRow();
  return row?.data?.integrations?.googleCalendar || null;
}

async function exchangeCodeForTokens(code) {
  const { googleClientId, googleClientSecret, googleRedirectUri } = getConfig();
  const body = new URLSearchParams({
    code,
    client_id: googleClientId,
    client_secret: googleClientSecret,
    redirect_uri: googleRedirectUri,
    grant_type: 'authorization_code',
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token exchange failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function refreshAccessToken(refreshToken) {
  const { googleClientId, googleClientSecret } = getConfig();
  const body = new URLSearchParams({
    client_id: googleClientId,
    client_secret: googleClientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token refresh failed (${response.status}): ${text}`);
  }

  return response.json();
}

function toIsoDate(date) {
  return date.toISOString().split('T')[0];
}

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function formatEvent(event) {
  const start = event.start?.dateTime || event.start?.date || null;
  const end = event.end?.dateTime || event.end?.date || null;
  return {
    id: event.id,
    status: event.status,
    summary: event.summary || '(Untitled event)',
    description: event.description || '',
    location: event.location || '',
    htmlLink: event.htmlLink || '',
    start,
    end,
    isAllDay: !!event.start?.date,
  };
}

async function fetchTodayEvents(accessToken) {
  const timeMin = startOfDay().toISOString();
  const timeMax = endOfDay().toISOString();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '10',
  });

  const response = await fetch(`${GOOGLE_CALENDAR_BASE}/calendars/primary/events?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Calendar fetch failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return (data.items || []).map(formatEvent);
}

function computeFreeWindows(events) {
  const dayStart = startOfDay();
  const dayEnd = endOfDay();
  const timedEvents = events
    .filter(event => event.start && event.end && !event.isAllDay)
    .map(event => ({
      start: new Date(event.start),
      end: new Date(event.end),
    }))
    .sort((a, b) => a.start - b.start);

  const windows = [];
  let cursor = new Date(dayStart);

  for (const event of timedEvents) {
    if (event.start > cursor) {
      const minutes = Math.round((event.start - cursor) / 60000);
      if (minutes >= 15) {
        windows.push({
          start: cursor.toISOString(),
          end: event.start.toISOString(),
          minutes,
        });
      }
    }
    if (event.end > cursor) cursor = event.end;
  }

  if (dayEnd > cursor) {
    const minutes = Math.round((dayEnd - cursor) / 60000);
    if (minutes >= 15) {
      windows.push({
        start: cursor.toISOString(),
        end: dayEnd.toISOString(),
        minutes,
      });
    }
  }

  return windows;
}

async function getValidCalendarSession() {
  const integration = await getCalendarIntegration();
  if (!integration?.refreshToken) {
    return { connected: false, reason: 'Google Calendar not connected' };
  }

  const expiresAt = integration.expiresAt ? new Date(integration.expiresAt).getTime() : 0;
  const stillValid = integration.accessToken && expiresAt > Date.now() + 60 * 1000;

  if (stillValid) {
    return { connected: true, accessToken: integration.accessToken, integration };
  }

  const refreshed = await refreshAccessToken(integration.refreshToken);
  const nextIntegration = {
    ...integration,
    accessToken: refreshed.access_token,
    expiresAt: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString(),
    refreshedAt: new Date().toISOString(),
    scope: refreshed.scope || integration.scope || GOOGLE_SCOPE,
    tokenType: refreshed.token_type || integration.tokenType || 'Bearer',
  };

  await saveIntegrationState(nextIntegration);
  return { connected: true, accessToken: nextIntegration.accessToken, integration: nextIntegration };
}

module.exports = {
  buildGoogleAuthUrl,
  computeFreeWindows,
  exchangeCodeForTokens,
  fetchTodayEvents,
  getCalendarIntegration,
  getConfig,
  getValidCalendarSession,
  saveIntegrationState,
  toIsoDate,
};
