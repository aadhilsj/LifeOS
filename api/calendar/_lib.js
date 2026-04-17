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
    appBaseUrl: process.env.APP_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || '',
  };
}

function getIntegrationRowId(userId) {
  return userId || process.env.KAIRO_DATA_ROW_ID || 'main';
}

function buildState(userId) {
  return Buffer.from(JSON.stringify({
    nonce: Math.random().toString(36).slice(2, 10),
    createdAt: Date.now(),
    userId: userId || '',
  })).toString('base64url');
}

function parseState(state) {
  if (!state) return {};
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function buildGoogleAuthUrl(userId) {
  const { googleClientId, googleRedirectUri } = getConfig();
  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: googleRedirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: GOOGLE_SCOPE,
    state: buildState(userId),
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

async function loadLifeOsRow(userId) {
  const integrationRowId = getIntegrationRowId(userId);
  const rows = await supabaseRequest(`lifeos_data?id=eq.${encodeURIComponent(integrationRowId)}&select=id,data`);
  return rows?.[0] || null;
}

function normalizeCalendarConnection(connection, index = 0) {
  if (!connection || typeof connection !== 'object') return null;
  if (!connection.refreshToken && !connection.accessToken) return null;

  const email = connection.email || connection.calendarEmail || connection.calendarId || '';
  const fallbackId = email ? `google-${slugify(email)}` : `google-${index + 1}`;

  return {
    id: connection.id || fallbackId,
    email,
    displayName: connection.displayName || connection.summary || email || `Google Calendar ${index + 1}`,
    calendarId: connection.calendarId || email || 'primary',
    accessToken: connection.accessToken || '',
    refreshToken: connection.refreshToken || '',
    expiresAt: connection.expiresAt || null,
    connectedAt: connection.connectedAt || connection.createdAt || new Date().toISOString(),
    refreshedAt: connection.refreshedAt || connection.connectedAt || null,
    scope: connection.scope || GOOGLE_SCOPE,
    tokenType: connection.tokenType || 'Bearer',
    lastError: connection.lastError || '',
  };
}

function normalizeCalendarIntegration(integration) {
  if (!integration || typeof integration !== 'object') {
    return {
      version: 2,
      updatedAt: null,
      connections: [],
    };
  }

  if (Array.isArray(integration.connections)) {
    return {
      version: 2,
      updatedAt: integration.updatedAt || integration.refreshedAt || integration.connectedAt || null,
      connections: integration.connections
        .map((connection, index) => normalizeCalendarConnection(connection, index))
        .filter(Boolean),
    };
  }

  const legacyConnection = normalizeCalendarConnection(integration, 0);
  return {
    version: 2,
    updatedAt: integration.updatedAt || integration.refreshedAt || integration.connectedAt || null,
    connections: legacyConnection ? [legacyConnection] : [],
  };
}

function upsertCalendarConnection(integration, connection) {
  const normalized = normalizeCalendarIntegration(integration);
  const nextConnection = normalizeCalendarConnection(connection, normalized.connections.length);
  if (!nextConnection) return normalized;

  const matchIndex = normalized.connections.findIndex(existing =>
    (nextConnection.email && existing.email && existing.email === nextConnection.email) ||
    existing.id === nextConnection.id
  );

  const nextConnections = [...normalized.connections];
  if (matchIndex >= 0) {
    nextConnections[matchIndex] = {
      ...nextConnections[matchIndex],
      ...nextConnection,
    };
  } else {
    nextConnections.push(nextConnection);
  }

  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    connections: nextConnections,
  };
}

async function saveIntegrationState(nextIntegrationState, userId) {
  const integrationRowId = getIntegrationRowId(userId);
  const existing = await loadLifeOsRow(userId);
  const currentData = existing?.data && typeof existing.data === 'object' ? existing.data : {};
  const normalizedIntegration = normalizeCalendarIntegration(nextIntegrationState);
  const nextData = {
    ...currentData,
    integrations: {
      ...(currentData.integrations || {}),
      googleCalendar: normalizedIntegration,
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

async function getCalendarIntegration(userId) {
  const row = await loadLifeOsRow(userId);
  return normalizeCalendarIntegration(row?.data?.integrations?.googleCalendar || null);
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

async function fetchPrimaryCalendar(accessToken) {
  const response = await fetch(`${GOOGLE_CALENDAR_BASE}/users/me/calendarList/primary`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Calendar primary calendar lookup failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function buildCalendarConnection(tokenData, existingConnection = null) {
  const now = Date.now();
  const primaryCalendar = await fetchPrimaryCalendar(tokenData.access_token);
  const email = primaryCalendar.id || existingConnection?.email || '';
  const displayName = primaryCalendar.summary || email || existingConnection?.displayName || 'Google Calendar';

  return normalizeCalendarConnection({
    ...existingConnection,
    id: existingConnection?.id || (email ? `google-${slugify(email)}` : `google-${now}`),
    email,
    displayName,
    calendarId: primaryCalendar.id || existingConnection?.calendarId || 'primary',
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || existingConnection?.refreshToken || '',
    expiresAt: new Date(now + (tokenData.expires_in || 3600) * 1000).toISOString(),
    connectedAt: existingConnection?.connectedAt || new Date(now).toISOString(),
    refreshedAt: new Date(now).toISOString(),
    scope: tokenData.scope || existingConnection?.scope || GOOGLE_SCOPE,
    tokenType: tokenData.token_type || existingConnection?.tokenType || 'Bearer',
    lastError: '',
  });
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

async function fetchTodayEvents(accessToken, source = {}) {
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
  return (data.items || []).map(event => ({
    ...formatEvent(event),
    sourceId: source.id || '',
    sourceEmail: source.email || '',
    sourceLabel: source.displayName || source.email || '',
  }));
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

async function getValidCalendarSessions(userId) {
  const integration = await getCalendarIntegration(userId);
  if (!integration.connections.length) {
    return { connected: false, reason: 'Google Calendar not connected', sessions: [], integration };
  }

  const sessions = [];
  const nextConnections = [];
  let didChange = false;

  for (const connection of integration.connections) {
    try {
      const expiresAt = connection.expiresAt ? new Date(connection.expiresAt).getTime() : 0;
      const stillValid = connection.accessToken && expiresAt > Date.now() + 60 * 1000;

      if (stillValid) {
        sessions.push({
          accessToken: connection.accessToken,
          connection,
        });
        nextConnections.push({
          ...connection,
          lastError: '',
        });
        continue;
      }

      const refreshed = await refreshAccessToken(connection.refreshToken);
      const nextConnection = normalizeCalendarConnection({
        ...connection,
        accessToken: refreshed.access_token,
        expiresAt: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString(),
        refreshedAt: new Date().toISOString(),
        scope: refreshed.scope || connection.scope || GOOGLE_SCOPE,
        tokenType: refreshed.token_type || connection.tokenType || 'Bearer',
        lastError: '',
      });

      sessions.push({
        accessToken: nextConnection.accessToken,
        connection: nextConnection,
      });
      nextConnections.push(nextConnection);
      didChange = true;
    } catch (error) {
      nextConnections.push({
        ...connection,
        lastError: error.message,
      });
      didChange = true;
    }
  }

  if (didChange) {
    await saveIntegrationState({
      ...integration,
      updatedAt: new Date().toISOString(),
      connections: nextConnections,
    }, userId);
  }

  if (!sessions.length) {
    return { connected: false, reason: 'No valid Google Calendar connections found', sessions: [], integration: { ...integration, connections: nextConnections } };
  }

  return {
    connected: true,
    sessions,
    integration: {
      ...integration,
      connections: nextConnections,
    },
  };
}

module.exports = {
  buildCalendarConnection,
  buildGoogleAuthUrl,
  computeFreeWindows,
  exchangeCodeForTokens,
  fetchTodayEvents,
  getCalendarIntegration,
  getConfig,
  getIntegrationRowId,
  getValidCalendarSessions,
  normalizeCalendarIntegration,
  parseState,
  saveIntegrationState,
  toIsoDate,
  upsertCalendarConnection,
};
