// Pure layout model for the widget-style popup.
//
// The popup uses one global grid for every provider.  A provider card spans a
// rectangle of that grid; its width comes from the number of gauge columns the
// user picked and its height comes from the number of gauge rows.  Positions
// are grid cells, never pixels, so every gauge in every card shares the same
// column tracks and row tracks.

export const LAYOUT_VERSION = 1;
export const DEFAULT_LAYOUT_COLUMNS = 3;
export const MAX_LAYOUT_COLUMNS = 5;
// The one row bound.  Saved coordinates come from dconf, which a user can
// hand-edit, so the packer never trusts a row past it (a huge row would make
// it allocate that many grid rows and freeze the Shell).  It is also the
// ceiling on grid rows the packer allocates, so every packed row is below it,
// and the settings server (validate_layout) and the web editor accept rows up
// to the same value: a packed layout always survives save and re-parse.
export const MAX_LAYOUT_ROW = 1000;

/** A saved col/row as a safe non-negative integer, or null when unusable. */
export function clampGridCoordinate(value, max) {
    if (!Number.isInteger(value))
        return null;
    return Math.max(0, Math.min(max, value));
}

/**
 * Grammar of the part of a layout id after `<providerKey>:`.  This is the one
 * definition in the JS code (`isPersistableLayoutId` in
 * web-settings/store.js imports it); the Python consumer that must stay in sync
 * is `_LAYOUT_ID_SUFFIX` / `validate_layout` in settings_server.py.  Anything
 * `assignLayoutIds` emits must match, or saving the layout drops that card or
 * fails the whole request.
 */
export const LAYOUT_ID_SUFFIX_PATTERN = /^[A-Za-z0-9._:#@+=-]{1,64}$/;
const LAYOUT_ID_SUFFIX_MAX = 64;

/**
 * Maps a raw workspace id onto the suffix grammar (disallowed chars become '_',
 * truncated to 64).  Deterministic and never empty: an id that sanitises to
 * nothing (an empty string) falls back to 'ws'.
 */
export function sanitizeLayoutSuffix(raw) {
    const suffix = String(raw ?? '')
        .replace(/[^A-Za-z0-9._:#@+=-]/g, '_')
        .slice(0, LAYOUT_ID_SUFFIX_MAX);
    return suffix || 'ws';
}

/**
 * Layout id of one Codex workspace card: `codex:<sanitised workspace id>`.
 * Pure: depends only on the workspace id, never on list position or on which
 * other workspaces are present.  Two raw ids that sanitise to the same suffix
 * share this id; `assignLayoutIds` disambiguates those with a `#n` counter.
 */
export function codexLayoutId(workspaceId) {
    return `codex:${sanitizeLayoutSuffix(workspaceId)}`;
}

function hasWorkspaceId(status) {
    const id = status?.workspace_id;
    return id !== undefined && id !== null && String(id) !== '';
}

/**
 * Unique layout id for every status, stable for a given workspace.
 *
 * Providers normally appear once and keep their provider key.  Codex reports
 * one status per workspace, all with key 'codex'.  A status that has a
 * `workspace_id` ALWAYS gets `key:<sanitised workspace id>`, wherever it sits
 * in the list, so a card's saved layout entry follows its workspace when
 * another workspace fails, is deselected or reorders.  The workspace id is
 * sanitised to LAYOUT_ID_SUFFIX_PATTERN.  When different raw ids sanitise to
 * the same suffix, the one with the smallest raw id (then list order, for
 * duplicates of the very same id) keeps the plain suffix and the others get a
 * `#n` counter (still within 64 characters, truncating the workspace part),
 * assigned in raw-id order so fetch order never matters.
 *
 * A status WITHOUT a workspace id has no stable identity: the first keeps the
 * bare provider key (the id of its saved entry), later ones become
 * `key:#<index>`.  These never take a workspace's id.
 */
export function assignLayoutIds(statuses) {
    const list = statuses ?? [];
    const ids = new Array(list.length);
    const used = new Set();
    const withWorkspace = [];
    list.forEach((status, index) => {
        if (hasWorkspaceId(status)) {
            withWorkspace.push({
                index,
                key: String(status?.key ?? ''),
                raw: String(status.workspace_id),
                suffix: sanitizeLayoutSuffix(status.workspace_id),
            });
        }
    });
    // Code-unit order, so it is locale independent.
    const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    withWorkspace.sort((a, b) =>
        compare(a.key, b.key) || compare(a.raw, b.raw) || a.index - b.index);

    // First pass: every distinct plain id is claimed before any counter id is
    // generated, so a literal workspace id such as 'a#2' is never displaced.
    const pending = [];
    for (const item of withWorkspace) {
        const id = `${item.key}:${item.suffix}`;
        if (used.has(id)) {
            pending.push(item);
        } else {
            used.add(id);
            ids[item.index] = id;
        }
    }
    for (const item of pending) {
        let id;
        for (let n = 2; ; n++) {
            const counter = `#${n}`;
            const base = item.suffix.slice(0, LAYOUT_ID_SUFFIX_MAX - counter.length);
            id = `${item.key}:${base}${counter}`;
            if (!used.has(id))
                break;
        }
        used.add(id);
        ids[item.index] = id;
    }

    list.forEach((status, index) => {
        if (ids[index] !== undefined)
            return;
        const key = String(status?.key ?? '');
        let id = key;
        if (used.has(id)) {
            const suffix = `#${index}`;
            id = `${key}:${suffix}`;
            // Only reachable when a workspace id literally sanitised to '#<index>'.
            for (let n = 2; used.has(id); n++)
                id = `${key}:${suffix}#${n}`;
        }
        used.add(id);
        ids[index] = id;
    });
    return ids;
}

/**
 * One-time upgrade of a layout saved under the old id scheme, where the first
 * workspace status of a provider owned the bare provider key (`codex`).
 *
 * The bare entry belongs to the FIRST workspace of `workspaceIds`, the
 * remembered raw workspace ids (`codex-workspace-options`, whose stored order
 * is stable because new workspaces are appended).  The rule deliberately
 * ignores the workspace selection and which fetches failed this cycle, so the
 * popup and the settings page agree on who owns the legacy entry.  Returns a
 * new layout object with that entry renamed, or `layout` itself when nothing
 * applies: no bare entry, no remembered workspace yet (migrate later, once the
 * first successful fetch has remembered one), or the first workspace already
 * has an entry.  Applying it to its own result is therefore a no-op.
 */
export function migrateBareProviderEntry(layout, key, workspaceIds) {
    const providers = layout?.providers;
    const first = (workspaceIds ?? []).find(id => id !== undefined && id !== null && String(id) !== '');
    if (!Array.isArray(providers) || first === undefined)
        return layout;
    const bareIndex = providers.findIndex(entry => entry?.id === key);
    if (bareIndex < 0)
        return layout;
    const [id] = assignLayoutIds([{key, workspace_id: String(first)}]);
    if (providers.some(entry => entry?.id === id))
        return layout;
    return {
        ...layout,
        providers: providers.map((entry, index) =>
            index === bareIndex ? {...entry, id} : entry),
    };
}

/**
 * JSON wrapper around migrateBareProviderEntry for the saved `popup-layout`.
 * Returns the input string unchanged when it is empty, invalid or needs no
 * migration.
 */
export function migrateBareProviderLayoutJson(raw, key, workspaceIds) {
    if (!raw || typeof raw !== 'string')
        return raw;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_error) {
        return raw;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers))
        return raw;
    const layout = migrateBareProviderEntry(parsed, key, workspaceIds);
    return layout === parsed ? raw : JSON.stringify(layout);
}

/**
 * Keep the cards of a provider whose fetch failed in the shape they had when
 * it was healthy.
 *
 * A failed status has no `workspace_id`, so `assignLayoutIds` would give it
 * the bare provider key: its saved `codex:<workspace>` entries would be
 * dropped as unknown ids and N workspace cards would collapse into one
 * header-only card at a default position.  Instead, every `key` status without
 * a workspace id is replaced, at the position of the first such status, by one
 * placeholder status per REMEMBERED workspace (`remembered`: `{id, label}` in
 * stable stored order) that no status with a workspace id covers, restricted
 * to `selectedIds` when that is not empty.  A placeholder is a copy of a
 * failed status (so its error is still reachable) carrying that workspace id
 * and, when known, its remembered label as `plan`; `assignLayoutIds` then
 * gives it the same id as the healthy card.  Partial failure therefore turns
 * only the missing workspaces into placeholders and total failure turns every
 * selected remembered workspace into one.
 *
 * With no id-less status, no remembered workspace or nothing left to cover,
 * the statuses are returned unchanged (today's bare-key placeholder).  Pure:
 * returns a new array and never mutates its input.
 */
export function expandFailedWorkspaceStatuses(statuses, key, remembered = [], selectedIds = []) {
    const list = statuses ?? [];
    const failed = list.filter(status => status?.key === key && !hasWorkspaceId(status));
    if (!failed.length)
        return list;
    const covered = new Set(list
        .filter(status => status?.key === key && hasWorkspaceId(status))
        .map(status => String(status.workspace_id)));
    const selected = new Set((selectedIds ?? []).map(String));
    const seen = new Set();
    const missing = [];
    for (const option of remembered ?? []) {
        const id = option?.id === undefined || option?.id === null ? '' : String(option.id);
        if (!id || seen.has(id) || covered.has(id))
            continue;
        seen.add(id);
        if (selected.size && !selected.has(id))
            continue;
        missing.push({id, label: option.label ? String(option.label) : ''});
    }
    if (!missing.length)
        return list;
    const placeholders = missing.map((workspace, index) => {
        const source = failed[index] ?? failed[0];
        return {
            ...source,
            workspace_id: workspace.id,
            ...(workspace.label ? {plan: workspace.label} : {}),
            placeholder: true,
        };
    });
    const result = [];
    let inserted = false;
    for (const status of list) {
        if (status?.key === key && !hasWorkspaceId(status)) {
            if (!inserted) {
                result.push(...placeholders);
                inserted = true;
            }
            continue;
        }
        result.push(status);
    }
    return result;
}

export function normalizeLayoutColumns(value, fallback = DEFAULT_LAYOUT_COLUMNS) {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(1, Math.min(MAX_LAYOUT_COLUMNS, parsed));
}

/**
 * Keep the user's metric order, but never show a metric that the provider no
 * longer reports.  New metrics are appended in the order the backend returned
 * them.  When the available list is empty (preferences before the first popup
 * fetch), the saved order is preserved as-is.
 */
export function normalizeMetricOrder(order, available = []) {
    const availableList = [];
    const availableSet = new Set();
    for (const label of available ?? []) {
        if (typeof label !== 'string' || !label || availableSet.has(label))
            continue;
        availableSet.add(label);
        availableList.push(label);
    }

    const result = [];
    const seen = new Set();
    for (const label of order ?? []) {
        if (typeof label !== 'string' || !label || seen.has(label))
            continue;
        if (availableList.length && !availableSet.has(label))
            continue;
        seen.add(label);
        result.push(label);
    }
    for (const label of availableList) {
        if (!seen.has(label)) {
            seen.add(label);
            result.push(label);
        }
    }
    return result;
}

/**
 * The card's effective shape.  A two-gauge provider asked for three columns
 * still occupies two columns: the card wraps its content instead of leaving an
 * empty third cell.
 */
export function providerGridSpan(provider, availableMetrics = null, columns = DEFAULT_LAYOUT_COLUMNS) {
    const gridColumns = normalizeLayoutColumns(columns);
    const detected = availableMetrics !== null && availableMetrics !== undefined;
    const order = detected && !availableMetrics.length
        ? []
        : normalizeMetricOrder(provider?.order, availableMetrics ?? []);
    const count = order.length;
    const requested = normalizeLayoutColumns(provider?.gaugeColumns, gridColumns);
    const gaugeColumns = count
        ? Math.min(requested, gridColumns, count)
        : 1;
    const gaugeRows = count ? Math.ceil(count / gaugeColumns) : 0;
    return {
        order,
        gaugeColumns,
        gaugeRows,
        w: gaugeColumns,
        h: 1 + gaugeRows,
    };
}

function ensureRows(occupied, row, columns) {
    // Hard bound: every allocated row is below MAX_LAYOUT_ROW, so a bad
    // coordinate never turns into a multi-million row allocation and every
    // caller below can index the rows it asked for (all of them clamp first).
    const last = Math.min(row, MAX_LAYOUT_ROW - 1);
    while (occupied.length <= last)
        occupied.push(Array(columns).fill(false));
}

function canPlace(occupied, row, col, w, h, columns) {
    if (col < 0 || row < 0 || col + w > columns || row + h > MAX_LAYOUT_ROW)
        return false;
    ensureRows(occupied, row + h - 1, columns);
    for (let y = row; y < row + h; y++) {
        for (let x = col; x < col + w; x++) {
            if (occupied[y][x])
                return false;
        }
    }
    return true;
}

function markPlaced(occupied, row, col, w, h, columns) {
    ensureRows(occupied, row + h - 1, columns);
    for (let y = row; y < row + h; y++) {
        for (let x = col; x < col + w; x++)
            occupied[y][x] = true;
    }
}

function firstFreeSlot(occupied, w, h, columns) {
    for (let row = 0; row + h <= MAX_LAYOUT_ROW; row++) {
        for (let col = 0; col + w <= columns; col++) {
            if (canPlace(occupied, row, col, w, h, columns))
                return {col, row};
        }
    }
    // Grid full (only reachable with absurd provider counts or a card taller
    // than every free gap): clamp.  The card goes to the last row it can occupy
    // without leaving the grid, in column 0, overlapping whatever is there.
    // Callers guarantee h <= MAX_LAYOUT_ROW, so this is always in bounds.
    return {col: 0, row: MAX_LAYOUT_ROW - h};
}

/**
 * providerGridSpan, bounded so the card fits the grid: gauges past the last
 * row the grid can hold are dropped from the card (a defined, deterministic
 * rule for hand-edited or absurd layouts), keeping h <= MAX_LAYOUT_ROW.
 */
function boundedGridSpan(provider, availableMetrics, columns) {
    const span = providerGridSpan(provider, availableMetrics, columns);
    if (span.h <= MAX_LAYOUT_ROW)
        return span;
    const order = span.order.slice(0, (MAX_LAYOUT_ROW - 1) * span.gaugeColumns);
    return {
        ...span,
        order,
        gaugeRows: Math.ceil(order.length / span.gaugeColumns),
        h: 1 + Math.ceil(order.length / span.gaugeColumns),
    };
}

function availableFor(metricsByProvider, id) {
    return metricsByProvider.has(id) ? metricsByProvider.get(id) : null;
}

/**
 * Resolve every provider to a non-overlapping grid rectangle.  Explicit
 * positions from the editor are kept when they fit; stale or colliding
 * positions are packed into the first free slot in provider order.
 */
export function packLayout(layout, metricsByProvider = new Map(), options = {}) {
    const columns = normalizeLayoutColumns(layout?.columns ?? options.columns);
    const providers = [];
    const occupied = [];

    for (const provider of layout?.providers ?? []) {
        if (!provider || typeof provider.id !== 'string' || !provider.id)
            continue;
        const available = availableFor(metricsByProvider, provider.id);
        const span = boundedGridSpan(provider, available, columns);
        const requestedCol = clampGridCoordinate(provider.col, columns - 1);
        const requestedRow = clampGridCoordinate(provider.row, MAX_LAYOUT_ROW);
        let position = null;
        if (requestedCol !== null && requestedRow !== null
            && canPlace(occupied, requestedRow, requestedCol, span.w, span.h, columns)) {
            position = {col: requestedCol, row: requestedRow};
        } else {
            position = firstFreeSlot(occupied, span.w, span.h, columns);
        }
        markPlaced(occupied, position.row, position.col, span.w, span.h, columns);
        providers.push({
            ...provider,
            col: position.col,
            row: position.row,
            w: span.w,
            h: span.h,
            order: span.order,
            gaugeColumns: span.gaugeColumns,
        });
    }

    // Drop rows that no card occupies.  Without this, shrinking a card from
    // three gauge rows to two leaves a blank row behind and the next card
    // starts far below the previous group.
    const rowMap = new Map();
    let nextRow = 0;
    for (let row = 0; row < occupied.length; row++) {
        if (occupied[row].some(Boolean))
            rowMap.set(row, nextRow++);
    }
    for (const provider of providers)
        provider.row = rowMap.get(provider.row) ?? provider.row;

    return {
        version: LAYOUT_VERSION,
        columns,
        providers,
    };
}

export function defaultLayout(providerIds = [], metricsByProvider = new Map(), options = {}) {
    const columns = normalizeLayoutColumns(options.columns);
    const gaugeColumns = normalizeLayoutColumns(options.gaugeColumns, columns);
    const providers = [];
    for (const id of providerIds ?? []) {
        if (typeof id !== 'string' || !id)
            continue;
        providers.push({
            id,
            gaugeColumns,
            order: metricsByProvider.has(id) ? (metricsByProvider.get(id) ?? []) : [],
        });
    }
    return packLayout({version: LAYOUT_VERSION, columns, providers}, metricsByProvider, options);
}

/** `entries` without the col/row of cards that no longer fit in `columns`. */
export function dropUnfitPositions(entries, metrics, columns) {
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
 * A parsed layout object at exactly `columns` grid columns.  `columns` is the
 * user's maximum (the `layout-columns` setting), never derived from the saved
 * layout or its cards: the count stored inside the layout is overridden, and
 * cards that no longer fit where they were lose their position so the packer
 * re-places them.  This is the one rule the popup and the settings page share.
 */
export function fitParsedLayout(parsed, metrics, columns) {
    const count = normalizeLayoutColumns(columns);
    return {
        ...parsed,
        columns: count,
        providers: dropUnfitPositions(parsed.providers, metrics, count),
    };
}

function parseLayoutObject(raw) {
    if (!raw || typeof raw !== 'string')
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_error) {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers))
        return null;
    return parsed;
}

/**
 * parseLayout for a caller that owns the column count (`options.columns`, the
 * `layout-columns` setting): a saved layout's own count is ignored and the
 * result is exactly that wide.  Unparseable input falls back to the default
 * layout, as parseLayout does.
 */
export function parseLayoutAtColumns(raw, providerIds = [], metricsByProvider = new Map(), options = {}) {
    const parsed = parseLayoutObject(raw);
    if (!parsed)
        return defaultLayout(providerIds, metricsByProvider, options);
    return resolveParsedLayout(
        fitParsedLayout(parsed, metricsByProvider, options.columns),
        providerIds, metricsByProvider, options);
}

/**
 * Parse the saved JSON.  Invalid JSON, unknown providers, and stale metric
 * labels are tolerated so an interrupted upgrade never hides a provider.  The
 * column count stored in the layout wins over `options.columns`; use
 * parseLayoutAtColumns when the caller's count must win.
 */
export function parseLayout(raw, providerIds = [], metricsByProvider = new Map(), options = {}) {
    const parsed = parseLayoutObject(raw);
    if (!parsed)
        return defaultLayout(providerIds, metricsByProvider, options);
    return resolveParsedLayout(parsed, providerIds, metricsByProvider, options);
}

function resolveParsedLayout(parsed, providerIds, metricsByProvider, options) {
    const columns = normalizeLayoutColumns(parsed.columns ?? options.columns);
    const gaugeDefault = normalizeLayoutColumns(options.gaugeColumns, columns);
    const known = new Set(providerIds ?? []);
    const byId = new Map();
    const ordered = [];

    for (const entry of parsed.providers) {
        if (!entry || typeof entry.id !== 'string' || !known.has(entry.id) || byId.has(entry.id))
            continue;
        byId.set(entry.id, entry);
        ordered.push(entry.id);
    }
    for (const id of providerIds ?? []) {
        if (!byId.has(id))
            ordered.push(id);
    }

    const providers = ordered.map(id => {
        const entry = byId.get(id) ?? {};
        const available = metricsByProvider.get(id) ?? [];
        const provider = {
            id,
            gaugeColumns: normalizeLayoutColumns(entry.gaugeColumns ?? gaugeDefault, columns),
            order: metricsByProvider.has(id) && !available.length
                ? []
                : normalizeMetricOrder(entry.order, available),
        };
        const col = clampGridCoordinate(entry.col, columns - 1);
        const row = clampGridCoordinate(entry.row, MAX_LAYOUT_ROW);
        if (col !== null)
            provider.col = col;
        if (row !== null)
            provider.row = row;
        return provider;
    });

    return packLayout({version: LAYOUT_VERSION, columns, providers}, metricsByProvider, options);
}

export function layoutToJson(layout) {
    return JSON.stringify(layout ?? {});
}

function sum(values, start = 0, count = values.length) {
    let total = 0;
    for (let i = start; i < start + count; i++)
        total += values[i] ?? 0;
    return total;
}

/**
 * Pixel geometry for the global grid.  Row heights are content-driven: a row
 * containing a provider header is at least headerHeight tall, and a row
 * containing gauges is at least cellHeight tall.  Cards spanning several rows
 * sum those row heights, so gauges in different cards still share row tracks.
 */
export function layoutGrid(layout, metricsByProvider = new Map(), options = {}) {
    const columns = normalizeLayoutColumns(layout?.columns ?? options.columns);
    const cellWidth = Math.max(1, Number(options.cellWidth) || 1);
    const columnGap = Math.max(0, Number(options.columnGap) || 0);
    const rowGap = Math.max(0, Number(options.rowGap) || 0);
    const headerHeight = Math.max(0, Number(options.headerHeight) || 0);
    const cellHeight = Math.max(0, Number(options.cellHeight) || 0);
    const padding = Math.max(0, Number(options.padding) || 0);
    const cardGap = Math.max(0, Number(options.cardGap) || 0);

    // Always pack: it is idempotent for an already packed layout and layouts
    // are a few dozen cards, so there is no cached "already packed" shortcut.
    const packed = packLayout(layout ?? {columns, providers: []}, metricsByProvider, {columns});
    const rowHeights = [];
    const resolved = [];
    for (const provider of packed.providers) {
        while (rowHeights.length < provider.row + provider.h)
            rowHeights.push(0);
        rowHeights[provider.row] = Math.max(rowHeights[provider.row], headerHeight);
        for (let i = 1; i < provider.h; i++)
            rowHeights[provider.row + i] = Math.max(rowHeights[provider.row + i], cellHeight);
        resolved.push({...provider, gaugeRows: provider.h - 1});
    }

    const rowOffsets = [];
    let cursor = 0;
    for (let row = 0; row < rowHeights.length; row++) {
        rowOffsets[row] = cursor;
        cursor += rowHeights[row] + (row < rowHeights.length - 1 ? rowGap : 0);
    }

    const providers = resolved.map(provider => {
        const x = provider.col * (cellWidth + columnGap);
        const y = rowOffsets[provider.row] ?? 0;
        const width = provider.w * cellWidth + (provider.w - 1) * columnGap;
        const height = sum(rowHeights, provider.row, provider.h)
            + (provider.h - 1) * rowGap;
        // Text must land on whole pixels.  Fractional positions (e.g. an odd
        // card gap divided by two) make GNOME Shell's text rendering look
        // twisted and colour-fringed at these small font sizes.
        const snap = value => Math.round(value);
        const cardX = snap(x + cardGap / 2);
        const cardY = snap(y + cardGap / 2);
        const cardWidth = Math.max(1, snap(width - cardGap));
        const cardHeight = Math.max(1, snap(height - cardGap));
        const contentX = cardX;
        const gauges = provider.order.map((label, index) => {
            const gaugeRow = provider.row + 1 + Math.floor(index / provider.gaugeColumns);
            return {
                label,
                x: snap(contentX + padding
                    + (index % provider.gaugeColumns) * (cellWidth + columnGap)),
                y: snap((rowOffsets[gaugeRow] ?? 0) + cardGap / 2 + padding),
                width: Math.max(1, snap(cellWidth - 2 * padding)),
                height: Math.max(1, snap((rowHeights[gaugeRow] ?? cellHeight) - 2 * padding)),
            };
        });
        return {
            ...provider,
            x,
            y,
            width,
            height,
            card: {
                x: cardX,
                y: cardY,
                width: cardWidth,
                height: cardHeight,
            },
            header: {
                x: snap(contentX + padding),
                y: snap(y + cardGap / 2 + padding),
                width: Math.max(1, snap(cardWidth - 2 * padding)),
                height: Math.max(1, snap((rowHeights[provider.row] ?? headerHeight) - 2 * padding)),
            },
            gauges,
        };
    });

    return {
        columns,
        rows: rowHeights.length,
        rowHeights,
        padding,
        cardGap,
        width: columns * cellWidth + (columns - 1) * columnGap,
        height: cursor,
        providers,
    };
}

export function moveProvider(layout, id, col, row, metricsByProvider = new Map(), options = {}) {
    const providers = (layout?.providers ?? []).map(provider =>
        provider.id === id ? {...provider, col, row} : provider);
    return packLayout({...layout, providers}, metricsByProvider, options);
}

export function reorderProviders(layout, fromIndex, toIndex, metricsByProvider = new Map(), options = {}) {
    const providers = (layout?.providers ?? []).map(provider => ({...provider}));
    if (fromIndex < 0 || fromIndex >= providers.length)
        return packLayout(layout, metricsByProvider, options);
    const target = Math.max(0, Math.min(providers.length - 1, toIndex));
    const [moved] = providers.splice(fromIndex, 1);
    providers.splice(target, 0, moved);
    // Explicit coordinates belong to the old order; let the packer re-flow.
    for (const provider of providers) {
        delete provider.col;
        delete provider.row;
    }
    return packLayout({...layout, providers}, metricsByProvider, options);
}

export function moveGauge(layout, providerId, fromIndex, toIndex) {
    const providers = (layout?.providers ?? []).map(provider => {
        if (provider.id !== providerId)
            return provider;
        const order = [...(provider.order ?? [])];
        if (fromIndex < 0 || fromIndex >= order.length)
            return provider;
        const target = Math.max(0, Math.min(order.length - 1, toIndex));
        const [moved] = order.splice(fromIndex, 1);
        order.splice(target, 0, moved);
        return {...provider, order};
    });
    return {...layout, providers};
}

/**
 * Drop a card at an explicit grid cell.  Unlike moveProvider, the dropped card
 * wins collisions: it is placed first and any card it lands on is re-packed
 * around it.  A provider missing from the layout is added (drag from the
 * "hidden" tray).
 */
export function placeProvider(layout, id, col, row, metricsByProvider = new Map(), options = {}) {
    const providers = (layout?.providers ?? []).map(provider => ({...provider}));
    const index = providers.findIndex(provider => provider.id === id);
    const columns = normalizeLayoutColumns(layout?.columns ?? options.columns);
    const entry = index >= 0
        ? providers.splice(index, 1)[0]
        : {
            id,
            gaugeColumns: normalizeLayoutColumns(options.gaugeColumns ?? columns, columns),
            order: metricsByProvider.get(id) ?? [],
        };
    providers.unshift({...entry, col: Math.max(0, Math.trunc(col)), row: Math.max(0, Math.trunc(row))});
    return packLayout({...layout, columns, providers}, metricsByProvider, {...options, columns});
}

export function removeProvider(layout, id) {
    return {
        ...layout,
        providers: (layout?.providers ?? []).filter(provider => provider.id !== id),
    };
}

/** Put a gauge label at an index inside its card (re-showing a hidden gauge). */
export function insertGauge(layout, providerId, label, index) {
    const columns = normalizeLayoutColumns(layout?.columns);
    const providers = (layout?.providers ?? []).map(provider => {
        if (provider.id !== providerId)
            return provider;
        const previousOrder = (provider.order ?? []).filter(item => item !== label);
        const order = [...previousOrder];
        const target = Math.max(0, Math.min(order.length, Math.trunc(index)));
        order.splice(target, 0, label);
        const wasSingleRow = (provider.gaugeColumns ?? 1) >= previousOrder.length;
        const gaugeColumns = wasSingleRow
            ? Math.min(columns, order.length)
            : provider.gaugeColumns;
        return {...provider, gaugeColumns, order};
    });
    return {...layout, providers};
}

/** Provider ids in visual reading order: top to bottom, then left to right. */
export function layoutReadingOrder(layout) {
    return [...(layout?.providers ?? [])]
        .sort((a, b) => (a.row ?? 0) - (b.row ?? 0) || (a.col ?? 0) - (b.col ?? 0))
        .map(provider => provider.id);
}

export function setProviderGaugeColumns(layout, providerId, gaugeColumns, columns = layout?.columns) {
    const providers = (layout?.providers ?? []).map(provider =>
        provider.id === providerId
            ? {...provider, gaugeColumns: normalizeLayoutColumns(gaugeColumns, columns)}
            : provider);
    return {...layout, providers};
}
