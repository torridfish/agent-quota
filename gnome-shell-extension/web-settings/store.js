import {api} from './api.js';
import {
    layoutToJson,
    normalizeLayoutColumns,
    parseLayout,
} from '../layout-model.js';
import {normalizeProviderOrder, parseMetricOptions} from '../meter-layout.js';

export const state = {
    data: null,
    settings: {},
    layout: null,
    loading: false,
    error: null,
};

const events = new EventTarget();
let saveCount = 0;
let saveTimer = 0;
let toastTimer = 0;

export function subscribe(type, callback) {
    const listener = event => callback(event.detail);
    events.addEventListener(type, listener);
    return () => events.removeEventListener(type, listener);
}

function emit(type, detail = {}) {
    events.dispatchEvent(new CustomEvent(type, {detail}));
}

export function showToast(message, isError = false) {
    const element = document.getElementById('toast');
    if (!element)
        return;
    element.textContent = message;
    element.classList.toggle('error', isError);
    element.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => element.classList.remove('show'), 3200);
}

function setSaving(delta) {
    saveCount = Math.max(0, saveCount + delta);
    emit('save-status', {
        saving: saveCount > 0,
        count: saveCount,
    });
}

function markSaved() {
    emit('save-status', {saving: false, count: saveCount, saved: true});
}

export function followsConfigFile(data = state.data) {
    return Boolean(data && !data.settings['override-providers']
        && data.settings['use-cli-config'] !== false);
}

export function enabledProviderIds(data = state.data) {
    if (!data)
        return [];
    const allIds = data.providers.map(provider => provider.id);
    const ordered = normalizeProviderOrder(data.settings['provider-order'] ?? [], allIds);
    if (followsConfigFile(data)) {
        // Mirror the popup: without an override it shows config.toml's list.
        if (!Array.isArray(data.cliEnabled))
            return ordered;
        const enabled = new Set(data.cliEnabled);
        return ordered.filter(id => enabled.has(id));
    }
    const selected = new Set(data.settings.providers ?? []);
    return ordered.filter(id => selected.has(id));
}

/**
 * Settings that make `ids` exactly the providers shown in the popup.  Picking
 * providers in this page always takes over from config.toml.
 */
export function providerSelectionSettings(ids) {
    return {'override-providers': true, providers: [...ids]};
}

export function metricMap(data = state.data) {
    if (!data)
        return new Map();
    const hidden = new Set(data.settings['hidden-metrics'] ?? []);
    const grouped = parseMetricOptions(data.settings['metric-options'] ?? []);
    const result = new Map();
    for (const [provider, labels] of grouped) {
        // Keep an empty array for a provider whose gauges are all hidden.
        // layout-model uses the presence of the key to distinguish that from
        // "not detected yet", where the saved order should be preserved.
        result.set(provider, labels.filter(label =>
            !hidden.has(`${provider}:${label}`)));
    }
    return result;
}

export function buildLayout(data = state.data) {
    if (!data)
        return null;
    return parseLayout(
        data.settings['popup-layout'] ?? '',
        enabledProviderIds(data),
        metricMap(data),
        {
            columns: normalizeLayoutColumns(data.settings['layout-columns']),
            gaugeColumns: normalizeLayoutColumns(data.settings['layout-columns']),
        },
    );
}

export function hydrate(data) {
    state.data = data;
    state.settings = {...data.settings};
    // Keep the state object and the render model pointing at one settings
    // map; buildLayout()/enabledProviderIds() read through state.data.
    state.data.settings = state.settings;
    state.layout = buildLayout(data);
    state.error = null;
}

export async function loadState() {
    state.loading = true;
    emit('loading', {loading: true});
    try {
        hydrate(await api.state());
        emit('reload', {});
    } catch (error) {
        state.error = error.message;
        emit('reload', {error});
        throw error;
    } finally {
        state.loading = false;
        emit('loading', {loading: false});
    }
}

export async function refreshState() {
    await loadState();
}

/**
 * Optimistic single-key save.  The local value is updated immediately so the
 * controls stay responsive; a failed request reverts to the server value on
 * the next refresh and shows an error.
 */
const LAYOUT_SETTING_KEYS = new Set([
    'popup-layout', 'layout-columns', 'layout-gap', 'layout-padding',
    'layout-gauge-spacing', 'layout-gauge-columns', 'providers',
    'provider-order', 'hidden-metrics', 'override-providers', 'use-cli-config',
]);

export async function saveSetting(key, value) {
    const previous = state.settings[key];
    state.settings[key] = value;
    if (LAYOUT_SETTING_KEYS.has(key))
        state.layout = buildLayout();
    setSaving(1);
    let succeeded = false;
    try {
        const response = await api.setting(key, value);
        state.settings[key] = response.value;
        succeeded = true;
        return response.value;
    } catch (error) {
        state.settings[key] = previous;
        if (LAYOUT_SETTING_KEYS.has(key))
            state.layout = buildLayout();
        showToast(error.message, true);
        emit('save-error', {key, error});
        throw error;
    } finally {
        setSaving(-1);
        if (succeeded)
            markSaved();
    }
}


export async function saveLayout(layout, extraSettings = {}) {
    const raw = layoutToJson(layout);
    state.layout = layout;
    state.settings['popup-layout'] = raw;
    state.settings['layout-columns'] = layout.columns;
    for (const [key, value] of Object.entries(extraSettings))
        state.settings[key] = value;
    setSaving(1);
    let succeeded = false;
    try {
        await api.layout(layout, {
            'layout-columns': layout.columns,
            ...extraSettings,
        });
        succeeded = true;
        return true;
    } catch (error) {
        showToast(error.message, true);
        emit('save-error', {layout, error});
        throw error;
    } finally {
        setSaving(-1);
        if (succeeded)
            markSaved();
    }
}

/**
 * Apply several settings and a layout as one user action.  Local state is
 * updated first so the editor can re-render immediately; requests then run in
 * order (plain settings before the layout, which depends on them).  On failure
 * the page reloads the server state so it never shows unsaved data.
 */
export async function saveChange({settings = {}, layout = null} = {}) {
    const changed = Object.entries(settings).filter(([key, value]) =>
        JSON.stringify(state.settings[key]) !== JSON.stringify(value));
    for (const [key, value] of changed)
        state.settings[key] = value;
    if (layout) {
        state.settings['popup-layout'] = layoutToJson(layout);
        state.settings['layout-columns'] = layout.columns;
    }
    state.layout = buildLayout();
    const finalLayout = state.layout;
    setSaving(1);
    let succeeded = false;
    try {
        for (const [key, value] of changed)
            await api.setting(key, value);
        if (layout)
            await api.layout(finalLayout, {'layout-columns': finalLayout.columns});
        succeeded = true;
    } catch (error) {
        showToast(error.message, true);
        emit('save-error', {error});
        await loadState().catch(() => {});
    } finally {
        setSaving(-1);
        if (succeeded)
            markSaved();
    }
    return succeeded;
}

export async function saveSecret(provider, key, value) {
    setSaving(1);
    let succeeded = false;
    try {
        const response = await api.secret(provider, key, value);
        state.data.secrets[provider] = response.configured;
        succeeded = true;
        return response.configured;
    } catch (error) {
        showToast(error.message, true);
        throw error;
    } finally {
        setSaving(-1);
        if (succeeded)
            markSaved();
    }
}

export async function stopServer() {
    try {
        await api.stop();
        document.getElementById('server-dot')?.classList.add('bad');
        document.getElementById('server-state').textContent = 'Server stopped';
        showToast('Settings server stopped.');
    } catch (error) {
        showToast(error.message, true);
    }
}

export function providerById(id) {
    return state.data?.providers.find(provider => provider.id === id) ?? null;
}

export function providerTitle(id) {
    return providerById(id)?.title ?? id;
}

