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
let toastTimer = 0;

// Every write goes through one FIFO queue.  The settings server handles
// requests on concurrent threads, so overlapping requests could land in any
// order and persist an earlier edit last.  Local state is still updated
// synchronously (the page stays responsive); only the network is serialized.
let queue = Promise.resolve();
let pending = 0;
let needsReload = false;
// Last value the server confirmed per key.  Failure rollback restores this,
// not whatever a control wrote into `state.settings` while the user dragged.
let committed = {};

function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// Bumped by every queued write; a server re-read that started before the
// latest write may predate it and must not be applied.
let editEpoch = 0;

function enqueue(task) {
    pending += 1;
    editEpoch += 1;
    const run = queue.then(task);
    queue = run.then(() => {}, () => {});
    return run.finally(() => {
        pending -= 1;
        reloadIfNeeded();
    });
}

function reloadIfNeeded() {
    if (pending === 0 && needsReload) {
        needsReload = false;
        reloadWhenIdle();
    }
}

// After a failed write the page may hold values the server never accepted.
// Re-read the server state once the queue is empty.  The re-read is dropped
// when a write started meanwhile (it could clobber that optimistic change or
// predate it), but `needsReload` stays armed until a hydrate actually
// succeeds, so the next idle point tries again.
async function reloadWhenIdle() {
    const epoch = editEpoch;
    try {
        const data = await api.state();
        if (pending > 0 || epoch !== editEpoch) {
            needsReload = true;
            reloadIfNeeded();
            return;
        }
        hydrate(data);
        emit('reload', {});
    } catch (_error) {
        // The failed save already showed an error; a dead server is reported
        // by the connection listener.  Retry after the next write settles.
        needsReload = true;
    }
}

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
        // Mirror the popup and the CLI's _resolve_keys: without an override it
        // shows config.toml's list, but a list with no known provider is not a
        // usable selection and falls back to every provider.
        if (!Array.isArray(data.cliEnabled))
            return ordered;
        const enabled = new Set(data.cliEnabled);
        const usable = ordered.filter(id => enabled.has(id));
        return usable.length ? usable : ordered;
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

// Suffix rules for per-workspace card ids; keep in sync with validate_layout.
const EXTRA_ID_SUFFIX = /^[A-Za-z0-9._:#@+=-]{1,64}$/;

/**
 * Whether `id` is a known provider id or a per-workspace card id of the form
 * `<knownProviderId>:<suffix>` (see assignLayoutIds).  The settings page does
 * not render the latter, but must keep their saved entries.  Keep the suffix
 * rules in sync with validate_layout in settings_server.py.
 */
function isPersistableLayoutId(id, known) {
    if (typeof id !== 'string')
        return false;
    if (known.has(id))
        return true;
    const split = id.indexOf(':');
    return split > 0 && known.has(id.slice(0, split))
        && EXTRA_ID_SUFFIX.test(id.slice(split + 1));
}

/**
 * The layout to persist: the editable view (enabled providers only) plus the
 * saved entries of known providers that are currently disabled.  Without
 * this, toggling a provider off and then editing the layout would drop its
 * card order, columns and position, and re-enabling it would start from the
 * default.  Entries for per-workspace cards (`codex:<workspace id>`) are kept
 * the same way, since the settings page only knows provider ids.  The popup
 * parses the saved layout with its enabled ids, so extra entries are ignored
 * there until the provider is enabled again.
 */
export function mergeDisabledProviders(view, previousRaw, knownIds) {
    if (!view)
        return view;
    const known = new Set(knownIds ?? []);
    const present = new Set(view.providers.map(provider => provider.id));
    let previous = null;
    try {
        previous = typeof previousRaw === 'string' && previousRaw
            ? JSON.parse(previousRaw)
            : null;
    } catch (_error) {
        previous = null;
    }
    const kept = [];
    for (const entry of Array.isArray(previous?.providers) ? previous.providers : []) {
        if (!entry || typeof entry.id !== 'string' || !isPersistableLayoutId(entry.id, known)
            || present.has(entry.id))
            continue;
        present.add(entry.id);
        const item = {id: entry.id};
        item.gaugeColumns = normalizeLayoutColumns(entry.gaugeColumns, view.columns);
        item.order = Array.isArray(entry.order)
            ? entry.order.filter(label => typeof label === 'string')
            : [];
        for (const axis of ['col', 'row']) {
            if (Number.isInteger(entry[axis]) && entry[axis] >= 0 && entry[axis] <= 100)
                item[axis] = entry[axis];
        }
        kept.push(item);
    }
    return kept.length ? {...view, providers: [...view.providers, ...kept]} : view;
}

export function hydrate(data) {
    state.data = data;
    state.settings = {...data.settings};
    committed = structuredClone(data.settings);
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

// Settings that feed buildLayout(); changing one re-derives state.layout.
const LAYOUT_SETTING_KEYS = new Set([
    'popup-layout', 'layout-columns', 'layout-gap', 'layout-padding',
    'layout-gauge-spacing', 'providers',
    'provider-order', 'hidden-metrics', 'override-providers', 'use-cli-config',
]);

/**
 * Optimistic single-key save.  `saveSetting` owns the optimistic update: it
 * applies the value locally right away, queues the request, and on failure
 * rolls back to the last server-confirmed value (unless a newer edit of the
 * same key replaced it), re-renders and shows an error.  Callers should not
 * write `state.settings[key]` themselves before calling it.
 */
export function saveSetting(key, value) {
    state.settings[key] = value;
    if (LAYOUT_SETTING_KEYS.has(key))
        state.layout = buildLayout();
    setSaving(1);
    return enqueue(async () => {
        let succeeded = false;
        try {
            const response = await api.setting(key, value);
            committed[key] = response.value;
            if (sameValue(state.settings[key], value))
                state.settings[key] = response.value;
            succeeded = true;
            return response.value;
        } catch (error) {
            if (sameValue(state.settings[key], value)) {
                state.settings[key] = committed[key];
                if (LAYOUT_SETTING_KEYS.has(key))
                    state.layout = buildLayout();
            }
            needsReload = true;
            showToast(error.message, true);
            emit('save-error', {key, error});
            emit('rollback', {key});
            throw error;
        } finally {
            setSaving(-1);
            if (succeeded)
                markSaved();
        }
    });
}

function persistedLayout(layout, previousRaw) {
    return mergeDisabledProviders(
        layout, previousRaw, state.data?.providers.map(provider => provider.id));
}

// Settings POST /api/layout applies together with the layout in one
// all-or-nothing write.  Anything else goes through /api/settings first.
const LAYOUT_BATCH_KEYS = new Set([
    'provider-order', 'providers', 'override-providers',
    'layout-columns', 'layout-gap', 'layout-padding', 'layout-gauge-spacing',
]);

/**
 * Apply several settings and a layout as one user action.  Local state is
 * updated first so the editor can re-render immediately; requests then run
 * in the queue.  With a layout, every setting the layout endpoint supports
 * travels inside that single request (one atomic write, one popup refresh);
 * other settings are posted before it.  On failure unsaved values are rolled
 * back to the last confirmed ones (unless a newer edit replaced them) and the
 * page re-reads the server state once the queue has drained.  Never rejects;
 * resolves to success.
 */
export async function saveChange({settings = {}, layout = null} = {}) {
    const changed = Object.entries(settings).filter(([key, value]) =>
        !sameValue(state.settings[key], value));
    // Every key this call writes into local state, with the value it wrote.
    const applied = {};
    for (const [key, value] of changed) {
        state.settings[key] = value;
        applied[key] = value;
    }
    const previousRaw = state.settings['popup-layout'];
    if (layout) {
        state.settings['popup-layout'] = layoutToJson(layout);
        state.settings['layout-columns'] = layout.columns;
    }
    state.layout = buildLayout();
    const finalLayout = state.layout;
    let persisted = null;
    if (layout) {
        persisted = persistedLayout(finalLayout, previousRaw);
        state.settings['popup-layout'] = layoutToJson(persisted);
        state.settings['layout-columns'] = finalLayout.columns;
        applied['popup-layout'] = state.settings['popup-layout'];
        applied['layout-columns'] = finalLayout.columns;
    }
    const batched = {};
    const separate = [];
    for (const [key, value] of changed) {
        if (persisted && LAYOUT_BATCH_KEYS.has(key))
            batched[key] = value;
        else
            separate.push([key, value]);
    }
    if (persisted)
        batched['layout-columns'] = finalLayout.columns;
    setSaving(1);
    try {
        return await enqueue(async () => {
            let succeeded = false;
            try {
                for (const [key, value] of separate) {
                    await api.setting(key, value);
                    committed[key] = value;
                }
                if (persisted) {
                    await api.layout(persisted, batched);
                    committed['popup-layout'] = applied['popup-layout'];
                    for (const [key, value] of Object.entries(batched))
                        committed[key] = value;
                }
                succeeded = true;
            } catch (error) {
                rollbackApplied(applied);
                needsReload = true;
                showToast(error.message, true);
                emit('save-error', {error});
                emit('rollback', {});
            } finally {
                setSaving(-1);
                if (succeeded)
                    markSaved();
            }
            return succeeded;
        });
    } catch (_error) {
        return false;
    }
}

// Restore the last server-confirmed value of every key this failed save wrote,
// unless a newer edit has since replaced it.
function rollbackApplied(applied) {
    for (const [key, value] of Object.entries(applied)) {
        if (!sameValue(state.settings[key], value) || sameValue(committed[key], value))
            continue;
        if (key in committed)
            state.settings[key] = structuredClone(committed[key]);
        else
            delete state.settings[key];
    }
    state.layout = buildLayout();
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

