import {api, isConfigNotPersisted} from './api.js';
import {
    codexLayoutId,
    LAYOUT_ID_SUFFIX_PATTERN,
    layoutToJson,
    MAX_LAYOUT_ROW,
    normalizeLayoutColumns,
    normalizeMetricOrder,
    packLayout,
    parseLayout,
    providerGridSpan,
} from '../layout-model.js';
import {normalizeProviderOrder, parseMetricOptions} from '../meter-layout.js';
import {effectiveWorkspaceIds, selectionAfterWorkspaceToggle} from '../workspace-selection.js';

export const state = {
    data: null,
    settings: {},
    layout: null,
    loading: false,
    error: null,
    // Why config.toml cannot be used (server's `configError`), or null.
    configError: null,
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

// Transient, unsaved values shown while a control is being dragged.  They live
// beside `state.settings` (never in it), so an abandoned drag cannot leave a
// value that the server never confirmed in the settings map or in the
// comparisons saveSetting/saveChange make against it.  Read them through
// previewedSettings(); writing a key via saveSetting/saveChange, hydrating,
// or clearPreview() drops them.
let previews = {};

/** Show `value` for `key` in previews only; state.settings is not touched. */
export function previewSetting(key, value) {
    previews[key] = value;
}

export function hasPreview(key) {
    return key in previews;
}

/** Drop the preview of one key, or of every key when called without one. */
export function clearPreview(key) {
    if (key === undefined)
        previews = {};
    else
        delete previews[key];
}

/** state.settings with any live previews laid over it; for renderers only. */
export function previewedSettings() {
    return Object.keys(previews).length ? {...state.settings, ...previews} : state.settings;
}

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

// A write the server applied but could not mirror to config.toml.  The value
// stays; the page shows the reason in its banner and toast.
function noteConfigNotPersisted(error) {
    state.configError = error.configError ?? error.message;
    showToast(error.message, true);
    emit('config-error', {message: state.configError});
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

/** The provider a layout card id belongs to: `codex:<workspace>` -> `codex`. */
export function cardProviderId(id) {
    const text = String(id ?? '');
    const split = text.indexOf(':');
    return split > 0 ? text.slice(0, split) : text;
}

/** Codex workspaces the page knows (the server's remembered list). */
export function workspaceOptions(data = state.data) {
    return (data?.workspaces ?? []).filter(option =>
        option && typeof option.id === 'string' && option.id);
}

/**
 * The remembered workspaces the popup shows: `codex-workspaces` is the
 * selection, and an empty one means all of them (like the extension).  A
 * selection that matches no remembered workspace also shows all of them, so
 * the editor never ends up with Codex enabled and no card.  The rule lives in
 * `effectiveWorkspaceIds`, shared with the popup.
 */
export function selectedWorkspaces(data = state.data) {
    const options = workspaceOptions(data);
    const configured = data?.settings?.['codex-workspaces'] ?? [];
    const shown = new Set(effectiveWorkspaceIds(options.map(option => option.id), configured));
    return options.filter(option => shown.has(option.id));
}

function workspaceCard(option, data) {
    const provider = data?.providers?.find(item => item.id === 'codex');
    const label = typeof option.label === 'string' && option.label && option.label !== option.id
        ? option.label
        : `${provider?.title ?? 'Codex'} \u00b7 ${option.id}`;
    return {
        id: codexLayoutId(option.id),
        providerId: 'codex',
        workspaceId: option.id,
        title: label,
    };
}

/**
 * Every card the Layout page can show: one per provider, except Codex, which
 * has one per remembered workspace (`codex:<suffix>`).  With no workspace
 * known yet Codex is the single bare `codex` card.
 */
export function layoutCards(data = state.data) {
    if (!data)
        return [];
    const options = workspaceOptions(data);
    const seen = new Set();
    const cards = [];
    const add = card => {
        if (!seen.has(card.id)) {
            seen.add(card.id);
            cards.push(card);
        }
    };
    for (const provider of data.providers) {
        if (provider.id === 'codex' && options.length) {
            for (const option of options)
                add(workspaceCard(option, data));
        } else {
            add({id: provider.id, providerId: provider.id, title: provider.title ?? provider.id});
        }
    }
    return cards;
}

/**
 * The card id that owns a legacy bare `codex` layout entry: the first
 * workspace in the remembered list (`codex-workspace-options`, whose stored
 * order is stable), whatever `codex-workspaces` selects and whether or not a
 * refresh succeeded.  The extension's migration uses the same rule.  Null
 * while no workspace is remembered (Codex is then the bare `codex` card).
 */
export function legacyCodexCardId(data = state.data) {
    const [first] = workspaceOptions(data);
    return first ? codexLayoutId(first.id) : null;
}

/** Ids of the cards the popup shows now: enabled providers, Codex by workspace. */
export function enabledCardIds(data = state.data) {
    if (!data)
        return [];
    const options = workspaceOptions(data);
    const ids = [];
    for (const id of enabledProviderIds(data)) {
        if (id === 'codex' && options.length) {
            for (const option of selectedWorkspaces(data)) {
                const card = codexLayoutId(option.id);
                if (!ids.includes(card))
                    ids.push(card);
            }
        } else if (!ids.includes(id)) {
            ids.push(id);
        }
    }
    return ids;
}

/** Title, icon provider and workspace of a card id (works for stale ids too). */
export function cardInfo(id, data = state.data) {
    const known = layoutCards(data).find(card => card.id === id);
    if (known)
        return known;
    const providerId = cardProviderId(id);
    const provider = data?.providers?.find(item => item.id === providerId);
    return {id, providerId, title: provider?.title ?? id};
}

/**
 * Settings that make `cardIds` exactly the cards in the popup: the provider
 * selection (a provider is on while any of its cards is) and, for Codex, the
 * `codex-workspaces` selection the Providers page toggles.  The workspace
 * selection is only touched while a workspace card remains: dropping the last
 * Codex card turns the provider off and leaves the selection as it was, and
 * adding a workspace card back to a disabled Codex selects just that card.
 */
export function cardSelectionSettings(cardIds, data = state.data) {
    const providerIds = [];
    for (const id of cardIds) {
        const provider = cardProviderId(id);
        if (!providerIds.includes(provider))
            providerIds.push(provider);
    }
    const settings = providerSelectionSettings(providerIds);
    const options = workspaceOptions(data);
    const shown = new Set(cardIds);
    const chosen = options.filter(option => shown.has(codexLayoutId(option.id)));
    if (chosen.length) {
        const configured = data?.settings?.['codex-workspaces'] ?? [];
        const available = [...new Set(options.map(option => option.id))];
        // Same normalisation as the Providers page toggle (empty = all, ids
        // that are no longer remembered stay), applied once per workspace:
        // this sets the whole selection where that toggles one workspace.
        // Selecting first means the selection can never pass through empty
        // (selectionAfterWorkspaceToggle answers null for that).
        const wanted = new Set(chosen.map(option => option.id));
        let next = configured;
        for (const active of [true, false]) {
            for (const id of available) {
                if (wanted.has(id) !== active)
                    continue;
                next = selectionAfterWorkspaceToggle(available, next, id, active) ?? next;
            }
        }
        if (!sameValue(next, configured))
            settings['codex-workspaces'] = next;
    }
    return settings;
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
    // Every Codex workspace card shows the provider's gauges.
    if (result.has('codex')) {
        for (const option of workspaceOptions(data))
            result.set(codexLayoutId(option.id), [...result.get('codex')]);
    }
    return result;
}

/** `entries` without the col/row of cards that no longer fit in `columns`. */
function dropUnfitPositions(entries, metrics, columns) {
    return entries.map(entry => {
        if (!entry || !Number.isInteger(entry.col))
            return entry;
        const available = metrics.has(entry.id) ? metrics.get(entry.id) : null;
        const span = providerGridSpan(entry, available, columns);
        if (entry.col + span.w <= columns)
            return entry;
        const {col: _col, row: _row, ...rest} = entry;
        return rest;
    });
}

/**
 * `layout` at exactly `columns` grid columns: cards wider than that are
 * clamped to it and cards that no longer fit where they were are re-packed
 * into the first free slot.  The column count is the user's maximum, never
 * derived from the cards.
 */
export function fitLayoutToColumns(layout, metrics, columns) {
    const count = normalizeLayoutColumns(columns);
    const providers = dropUnfitPositions(layout?.providers ?? [], metrics, count);
    return packLayout({...layout, columns: count, providers}, metrics, {columns: count});
}

/**
 * The saved layout JSON as the view needs it: forced to `columns` (a saved
 * layout carries its own count, which parseLayout would otherwise prefer),
 * positions that no longer fit dropped, and a legacy bare `codex` entry handed
 * to `legacyCardId` (see legacyCodexCardId) when that card is in `cardIds` and
 * has no entry of its own.  When it is not in `cardIds` (its workspace is
 * unselected) the bare entry is left as it is, and no other card takes it.
 * Unparseable input is returned unchanged.  Nothing is written back here;
 * mergeDisabledProviders drops the bare entry when the layout is next saved
 * with that card in the view.
 */
export function adaptSavedLayout(raw, {
    cardIds = [], columns, metrics = new Map(), legacyCardId = null,
} = {}) {
    if (typeof raw !== 'string' || !raw)
        return raw;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_error) {
        return raw;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers))
        return raw;
    const count = normalizeLayoutColumns(columns);
    let entries = parsed.providers.filter(entry => entry && typeof entry === 'object');
    if (legacyCardId && cardIds.includes(legacyCardId)
        && !entries.some(entry => entry.id === legacyCardId)) {
        const bare = entries.findIndex(entry => entry.id === 'codex');
        if (bare >= 0) {
            entries = entries.map((entry, index) =>
                index === bare ? {...entry, id: legacyCardId} : entry);
        }
    }
    return JSON.stringify({
        ...parsed,
        columns: count,
        providers: dropUnfitPositions(entries, metrics, count),
    });
}

export function buildLayout(data = state.data) {
    if (!data)
        return null;
    // The popup width is the user's `layout-columns` maximum, whatever the
    // saved layout says or the cards need.
    const columns = normalizeLayoutColumns(data.settings['layout-columns']);
    const metrics = metricMap(data);
    const ids = enabledCardIds(data);
    return parseLayout(
        adaptSavedLayout(data.settings['popup-layout'] ?? '', {
            cardIds: ids, columns, metrics, legacyCardId: legacyCodexCardId(data),
        }),
        ids,
        metrics,
        {columns, gaugeColumns: columns},
    );
}

/**
 * Whether `id` is a known provider id or a per-workspace card id of the form
 * `<knownProviderId>:<suffix>` (see codexLayoutId / assignLayoutIds), the
 * cards of Codex workspaces.  Keep the suffix rules in sync with
 * validate_layout in settings_server.py.
 */
function isPersistableLayoutId(id, known) {
    if (typeof id !== 'string')
        return false;
    if (known.has(id))
        return true;
    const split = id.indexOf(':');
    return split > 0 && known.has(id.slice(0, split))
        && LAYOUT_ID_SUFFIX_PATTERN.test(id.slice(split + 1));
}

function parseSavedProviders(previousRaw) {
    try {
        const previous = typeof previousRaw === 'string' && previousRaw
            ? JSON.parse(previousRaw)
            : null;
        return Array.isArray(previous?.providers) ? previous.providers : [];
    } catch (_error) {
        return [];
    }
}

/** A saved entry reduced to id, gaugeColumns, order and in-range col/row. */
function sanitizeSavedEntry(entry, fallbackColumns) {
    const item = {id: entry.id};
    item.gaugeColumns = normalizeLayoutColumns(entry.gaugeColumns, fallbackColumns);
    item.order = Array.isArray(entry.order)
        ? entry.order.filter(label => typeof label === 'string')
        : [];
    // Columns are at most MAX_LAYOUT_COLUMNS wide; the server allows a col up
    // to 100.  Rows share the packer's MAX_LAYOUT_ROW.
    for (const [axis, max] of [['col', 100], ['row', MAX_LAYOUT_ROW]]) {
        if (Number.isInteger(entry[axis]) && entry[axis] >= 0 && entry[axis] <= max)
            item[axis] = entry[axis];
    }
    return item;
}

/**
 * The layout to persist: the editable view (enabled providers only) plus the
 * saved entries of known providers that are currently disabled.  Without
 * this, toggling a provider off and then editing the layout would drop its
 * card order, columns and position, and re-enabling it would start from the
 * default.  Entries for per-workspace cards (`codex:<workspace id>`) are kept
 * the same way: a workspace that is not selected is preserved like a disabled
 * provider.  The legacy bare `codex` entry belongs to `legacyCardId` (the
 * first remembered workspace): it is dropped once that card is in the view,
 * since adaptSavedLayout handed it over (it must never be saved under a
 * second id too), and kept untouched while that card is not in the view, so
 * the extension's migration still finds it.  Without a `legacyCardId` (no
 * workspace remembered) it is dropped once the view has any workspace card.
 * The popup parses the saved layout with its enabled ids, so extra entries
 * are ignored there until the provider is enabled again.
 */
export function mergeDisabledProviders(view, previousRaw, knownIds, legacyCardId = null) {
    if (!view)
        return view;
    const known = new Set(knownIds ?? []);
    const present = new Set(view.providers.map(provider => provider.id));
    const bareConsumed = legacyCardId
        ? present.has(legacyCardId)
        : view.providers.some(provider => provider.id.startsWith('codex:'));
    const kept = [];
    for (const entry of parseSavedProviders(previousRaw)) {
        if (!entry || typeof entry.id !== 'string' || !isPersistableLayoutId(entry.id, known)
            || present.has(entry.id) || (bareConsumed && entry.id === 'codex'))
            continue;
        present.add(entry.id);
        kept.push(sanitizeSavedEntry(entry, view.columns));
    }
    return kept.length ? {...view, providers: [...view.providers, ...kept]} : view;
}

/**
 * `layout` with a card for `providerId` appended (not yet placed on the
 * grid), for adding a provider from the tray.  When the saved layout still
 * holds an entry for it (kept by mergeDisabledProviders while the provider
 * was off), that entry seeds the card: its gauge columns and gauge order
 * survive (reconciled against `metrics`: vanished labels dropped, new ones
 * appended; an empty or unknown metric list keeps the saved order as-is), and
 * its col/row stay as a placement hint only when they still fit inside the
 * grid.  Otherwise packLayout/placeProvider put the card in the first free
 * slot.  With nothing saved the card gets the defaults.  A layout that
 * already has the provider is returned unchanged.  `legacyCardId` (see
 * legacyCodexCardId) is the one card that falls back to a legacy bare `codex`
 * entry when it has none of its own, as adaptSavedLayout does.
 */
export function addProviderEntry(
    layout, providerId, previousRaw, metrics = new Map(), knownIds = null, legacyCardId = null,
) {
    if (layout.providers.some(provider => provider.id === providerId))
        return layout;
    const columns = normalizeLayoutColumns(layout.columns);
    const available = metrics.has(providerId) ? metrics.get(providerId) : null;
    const known = knownIds ? new Set(knownIds) : null;
    const savedEntries = parseSavedProviders(previousRaw);
    const usable = !known || isPersistableLayoutId(providerId, known);
    const saved = usable
        ? savedEntries.find(entry => entry && entry.id === providerId)
            ?? (providerId === legacyCardId
                ? savedEntries.find(entry => entry && entry.id === 'codex')
                : undefined)
        : undefined;
    let entry;
    if (saved) {
        entry = {...sanitizeSavedEntry(saved, columns), id: providerId};
        entry.order = normalizeMetricOrder(entry.order, available ?? []);
        const hasHint = 'col' in entry && 'row' in entry;
        if (hasHint) {
            const span = providerGridSpan(entry, available, columns);
            if (entry.col + span.w > columns)
                delete entry.col;
        }
        if (!hasHint || !('col' in entry)) {
            delete entry.col;
            delete entry.row;
        }
    } else {
        entry = {id: providerId, gaugeColumns: columns, order: available ?? []};
    }
    return {...layout, providers: [...layout.providers, entry]};
}

export function hydrate(data) {
    state.data = data;
    state.settings = {...data.settings};
    previews = {};
    committed = structuredClone(data.settings);
    // Keep the state object and the render model pointing at one settings
    // map; buildLayout()/enabledProviderIds() read through state.data.
    state.data.settings = state.settings;
    state.layout = buildLayout(data);
    state.error = null;
    state.configError = typeof data.configError === 'string' ? data.configError : null;
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
    'layout-gauge-spacing', 'providers', 'codex-workspaces',
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
    // The value is now the saved one; the transient preview has done its job.
    delete previews[key];
    state.settings[key] = value;
    if (LAYOUT_SETTING_KEYS.has(key))
        state.layout = buildLayout();
    setSaving(1);
    return enqueue(async () => {
        let succeeded = false;
        try {
            let response;
            try {
                response = await api.setting(key, value);
                succeeded = true;
            } catch (error) {
                // dconf has the value; only config.toml is stale.  Keep it.
                if (!isConfigNotPersisted(error))
                    throw error;
                response = {value};
                noteConfigNotPersisted(error);
            }
            committed[key] = response.value;
            if (sameValue(state.settings[key], value))
                state.settings[key] = response.value;
            return response.value;
        } catch (error) {
            if (sameValue(state.settings[key], value)) {
                // No committed value means the key was never saved: remove it
                // again (like rollbackApplied) instead of storing undefined.
                if (key in committed)
                    state.settings[key] = committed[key];
                else
                    delete state.settings[key];
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

/**
 * Set the popup's maximum width (`layout-columns`).  A saved layout is
 * repacked for the new width and written in the same request, since the popup
 * prefers the column count stored in the layout over the setting; without a
 * saved layout only the setting is written.  Resolves like saveChange or
 * saveSetting, so callers should catch.
 */
export function saveLayoutColumns(value) {
    const current = normalizeLayoutColumns(state.settings['layout-columns']);
    const columns = normalizeLayoutColumns(value, current);
    const saved = state.settings['popup-layout'];
    if (typeof saved === 'string' && saved && state.layout) {
        return saveChange({
            settings: {'layout-columns': columns},
            layout: fitLayoutToColumns(state.layout, metricMap(), columns),
        });
    }
    return saveSetting('layout-columns', columns);
}

function persistedLayout(layout, previousRaw) {
    return mergeDisabledProviders(
        layout, previousRaw, state.data?.providers.map(provider => provider.id),
        legacyCodexCardId());
}

// Settings POST /api/layout applies together with the layout in one
// all-or-nothing write, sent under the same key names.  The layout editor's
// hide/show/undo actions change `hidden-metrics` and `codex-workspaces` along
// with the layout, so they travel in that request too.  Anything else goes
// through /api/settings first.
const LAYOUT_BATCH_KEYS = new Set([
    'provider-order', 'providers', 'override-providers',
    'hidden-metrics', 'codex-workspaces',
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
    for (const key of Object.keys(settings))
        delete previews[key];
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
            let completed = false;
            try {
                // A config_not_persisted answer means the write did apply, so
                // the remaining requests still run and nothing is rolled back.
                let unmirrored = null;
                const tolerate = async call => {
                    try {
                        await call();
                    } catch (error) {
                        if (!isConfigNotPersisted(error))
                            throw error;
                        unmirrored = error;
                    }
                };
                for (const [key, value] of separate) {
                    await tolerate(() => api.setting(key, value));
                    committed[key] = value;
                }
                if (persisted) {
                    await tolerate(() => api.layout(persisted, batched));
                    committed['popup-layout'] = applied['popup-layout'];
                    for (const [key, value] of Object.entries(batched))
                        committed[key] = value;
                }
                if (unmirrored)
                    noteConfigNotPersisted(unmirrored);
                else
                    succeeded = true;
                completed = true;
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
            return completed;
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

