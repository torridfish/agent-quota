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
// Saved coordinates come from dconf, which a user can hand-edit.  The settings
// server accepts rows up to this value; the packer must never trust more, or a
// huge row would make it allocate that many grid rows and freeze the Shell.
export const MAX_LAYOUT_ROW = 100;
// Hard ceiling on grid rows the packer will ever allocate.
export const MAX_GRID_ROWS = 1000;

/** A saved col/row as a safe non-negative integer, or null when unusable. */
export function clampGridCoordinate(value, max) {
    if (!Number.isInteger(value))
        return null;
    return Math.max(0, Math.min(max, value));
}

/**
 * Unique layout id for every status.  Providers normally appear once and keep
 * their provider key, but Codex reports one status per workspace, all with key
 * 'codex'.  The first one keeps the bare key (the id the settings page saves
 * layouts under); later ones become `key:workspaceId` (or `key:#index`).
 */
export function assignLayoutIds(statuses) {
    const used = new Set();
    return (statuses ?? []).map((status, index) => {
        const key = String(status?.key ?? '');
        let id = key;
        if (used.has(id)) {
            const suffix = status?.workspace_id ? String(status.workspace_id) : `#${index}`;
            id = `${key}:${suffix}`;
            for (let n = 2; used.has(id); n++)
                id = `${key}:${suffix}#${n}`;
        }
        used.add(id);
        return id;
    });
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
    // Defensive cap: callers validate first, but a bad coordinate must never
    // turn into a multi-million row allocation.
    const last = Math.min(row, MAX_GRID_ROWS + 64);
    while (occupied.length <= last)
        occupied.push(Array(columns).fill(false));
}

function canPlace(occupied, row, col, w, h, columns) {
    if (col < 0 || row < 0 || col + w > columns || row + h > MAX_GRID_ROWS)
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
    for (let row = 0; row + h <= MAX_GRID_ROWS; row++) {
        for (let col = 0; col + w <= columns; col++) {
            if (canPlace(occupied, row, col, w, h, columns))
                return {col, row};
        }
    }
    // Grid full (only reachable with absurd provider counts): stack below.
    return {col: 0, row: occupied.length};
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
        const available = metricsByProvider.has(provider.id)
            ? metricsByProvider.get(provider.id)
            : null;
        const span = providerGridSpan(provider, available, columns);
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

/**
 * Parse the saved JSON.  Invalid JSON, unknown providers, and stale metric
 * labels are tolerated so an interrupted upgrade never hides a provider.
 */
export function parseLayout(raw, providerIds = [], metricsByProvider = new Map(), options = {}) {
    if (!raw || typeof raw !== 'string')
        return defaultLayout(providerIds, metricsByProvider, options);

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_error) {
        return defaultLayout(providerIds, metricsByProvider, options);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers))
        return defaultLayout(providerIds, metricsByProvider, options);

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

    const packed = packLayout(layout ?? {columns, providers: []}, metricsByProvider, {
        columns,
    });
    const rowHeights = [];
    const resolved = [];
    for (const provider of packed.providers) {
        const available = metricsByProvider.has(provider.id)
            ? metricsByProvider.get(provider.id)
            : null;
        const span = providerGridSpan(provider, available, columns);
        while (rowHeights.length < provider.row + span.h)
            rowHeights.push(0);
        rowHeights[provider.row] = Math.max(rowHeights[provider.row], headerHeight);
        for (let i = 1; i < span.h; i++)
            rowHeights[provider.row + i] = Math.max(rowHeights[provider.row + i], cellHeight);
        resolved.push({...provider, ...span});
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
