const token = new URLSearchParams(window.location.search).get('token') ?? '';

export function hasToken() {
    return Boolean(token);
}

export const SERVER_STOPPED_MESSAGE = 'Settings server stopped \u2014 reopen Preferences';

// The server exits after a long idle period or when stopped by hand; fetch
// then fails with a bare TypeError.  Report that as a connection change so the
// page can say so instead of showing "Failed to fetch".
let connected = true;
let stoppedOnPurpose = false;
const connectionListeners = new Set();

function setConnected(value) {
    if (connected === value)
        return;
    connected = value;
    for (const listener of connectionListeners)
        listener(value);
}

export function onConnectionChange(listener) {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
}

export function isStoppedOnPurpose() {
    return stoppedOnPurpose;
}

export async function request(path, {method = 'GET', body = null} = {}) {
    const headers = {'X-Agent-Quota-Token': token};
    if (body !== null)
        headers['Content-Type'] = 'application/json';
    let response;
    try {
        response = await fetch(path, {
            method,
            headers,
            body: body === null ? null : JSON.stringify(body),
            cache: 'no-store',
        });
    } catch (_error) {
        setConnected(false);
        throw new Error(SERVER_STOPPED_MESSAGE);
    }
    setConnected(true);
    let payload = null;
    try {
        payload = await response.json();
    } catch (_error) {
        // The server always sends JSON for API errors; keep a useful fallback
        // for a proxy or a truncated response.
    }
    if (!response.ok) {
        const error = new Error(payload?.error ?? `Settings request failed (${response.status})`);
        error.status = response.status;
        // Set only when the server applied the change but could not write
        // config.toml: {code: 'config_not_persisted', persisted: false}.
        error.code = payload?.code ?? null;
        error.persisted = payload?.persisted;
        error.configError = typeof payload?.configError === 'string' ? payload.configError : null;
        throw error;
    }
    return payload;
}

/**
 * Whether a failed write was applied (dconf holds it) but not mirrored to
 * config.toml.  The setting is live, so callers keep the new value.
 */
export function isConfigNotPersisted(error) {
    return error?.code === 'config_not_persisted' && error.persisted === false;
}

export const api = {
    state: () => request('/api/state'),
    setting: (key, value) => request('/api/settings', {method: 'POST', body: {key, value}}),
    // Atomic: the server validates every key and applies all of them or none.
    settingsBatch: settings => request('/api/settings/batch', {method: 'POST', body: {settings}}),
    layout: (layout, settings) => request('/api/layout', {method: 'POST', body: {layout, settings}}),
    secret: (provider, key, value) => request('/api/secret', {method: 'POST', body: {provider, key, value}}),
    health: () => request('/api/health'),
    stop: async () => {
        const result = await request('/api/stop', {method: 'POST', body: {}});
        stoppedOnPurpose = true;
        return result;
    },
};
