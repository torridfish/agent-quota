// Layout helpers for the popup quota meters, shared between extension.js, prefs.js, and tests.

export function normalizeMeterStyle(style) {
    return style === 'bar' ? 'bar' : 'circle';
}

export function normalizeCircleTextPosition(position) {
    return position === 'right' ? 'right' : 'below';
}

export function paddingKeyForStyle(style) {
    return normalizeMeterStyle(style) === 'circle' ? 'circle-provider-padding' : 'provider-padding';
}

export function headerSpacingKeyForStyle(style) {
    return normalizeMeterStyle(style) === 'circle' ? 'circle-header-spacing' : 'header-spacing';
}

export function spacingKeyForStyle(style) {
    return normalizeMeterStyle(style) === 'circle' ? 'circle-metric-spacing' : 'metric-spacing';
}

export function isPercentageMetric(metric) {
    return Boolean(metric && metric.pct !== null && metric.pct !== undefined);
}

export function normalizeGaugePercentMode(mode) {
    return ['percent', 'number', 'hidden'].includes(mode) ? mode : 'percent';
}

export function circlePercentText(pct, mode = 'percent') {
    const normalized = normalizeGaugePercentMode(mode);
    if (normalized === 'hidden')
        return '';
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    // Always floor so the number never reads higher than the gauge arc.
    const value = String(Math.floor(clamped));
    return normalized === 'number' ? value : `${value}%`;
}

export function displayMetricValue(metric) {
    const value = metric?.value ?? '';
    if (!isPercentageMetric(metric))
        return String(value);
    const text = String(value).trim();
    if (!/^\d+(?:\.\d+)?%$/.test(text))
        return value;
    return circlePercentText(metric.pct, 'percent');
}

export function chunkCircleMetrics(metrics, columns = 3) {
    const items = (metrics ?? []).filter(isPercentageMetric);
    if (!items.length)
        return [];

    const cols = Math.max(1, Math.trunc(Number(columns) || 3));
    const rowCount = Math.ceil(items.length / cols);
    const rows = Array.from({length: rowCount}, () => []);
    for (let r = 0; r < rowCount; r++) {
        for (let c = 0; c < cols; c++) {
            const index = c * rowCount + r;
            if (index < items.length)
                rows[r].push(items[index]);
        }
    }
    return rows;
}

export function chunkProviderColumns(statuses, columns = 1, breakBeforeKeys = []) {
    const items = statuses ?? [];
    if (!items.length)
        return [];

    const breakSet = new Set(breakBeforeKeys ?? []);
    const hasManualBreaks = items.some((status, index) => index > 0 && breakSet.has(status.key));
    const targetCols = Math.max(1, Math.trunc(Number(columns) || 1));

    if (hasManualBreaks) {
        const result = [[]];
        for (let i = 0; i < items.length; i++) {
            const status = items[i];
            if (i > 0 && breakSet.has(status.key))
                result.push([]);
            result[result.length - 1].push(status);
        }
        return result;
    }

    if (targetCols <= 1)
        return [items];

    const perCol = Math.ceil(items.length / targetCols);
    const result = [];
    for (let i = 0; i < items.length; i += perCol)
        result.push(items.slice(i, i + perCol));
    return result;
}

// Rough pixel estimates used only to compare candidate grid shapes. They mirror
// the CSS heights closely enough to pick the squarest column count without
// measuring actors before they are allocated.
const PROVIDER_HEIGHT_ESTIMATES = {
    header: 22,
    empty: 16,
    barRow: 25,
    circleTextBelow: 34,
    circleTextRight: 18,
};

export function estimateProviderHeight(status, options = {}) {
    const metrics = status?.metrics ?? [];
    const padding = Math.max(0, Number(options.padding) || 0);
    const headerSpacing = Math.max(0, Number(options.headerSpacing) || 0);
    const spacing = Math.max(0, Number(options.spacing) || 0);
    const height = PROVIDER_HEIGHT_ESTIMATES.header + headerSpacing + 2 * padding;
    if (!metrics.length)
        return height + PROVIDER_HEIGHT_ESTIMATES.empty;

    if (normalizeMeterStyle(options.meterStyle) === 'bar')
        return height + metrics.length * (PROVIDER_HEIGHT_ESTIMATES.barRow + spacing);

    const circleColumns = Math.max(1, Math.trunc(Number(options.circleColumns) || 1));
    const radius = Math.max(1, Number(options.circleRadius) || 16);
    const rows = Math.ceil(metrics.length / circleColumns);
    const text = options.circleTextPosition === 'right'
        ? PROVIDER_HEIGHT_ESTIMATES.circleTextRight
        : PROVIDER_HEIGHT_ESTIMATES.circleTextBelow;
    // Each gauge row carries the same header + spacing + padding pitch so
    // rows align across provider columns.
    return rows * (
        PROVIDER_HEIGHT_ESTIMATES.header + headerSpacing + 2 * padding
        + 1.7 * radius + text
    );
}

export function providerColumnsHeight(columns, options = {}) {
    return Math.max(0, ...(columns ?? []).map(column => column.reduce(
        (total, status) => total + estimateProviderHeight(status, options), 0)));
}

function candidateColumnSplits(items, cols) {
    const splits = [];
    const prefix = [];
    const walk = (start, remaining) => {
        if (remaining === 1) {
            const candidate = [...prefix, items.slice(start)];
            if (!candidate[candidate.length - 1].length)
                return;
            // Keep earlier columns at least as long as later ones so any empty
            // cells land in the bottom-right corner.
            for (let i = 1; i < candidate.length; i++) {
                if (candidate[i - 1].length < candidate[i].length)
                    return;
            }
            splits.push(candidate);
            return;
        }
        for (let end = start + 1; end <= items.length - (remaining - 1); end++) {
            prefix.push(items.slice(start, end));
            walk(end, remaining - 1);
            prefix.pop();
        }
    };
    walk(0, cols);
    return splits;
}

/**
 * Pick the contiguous column split, up to `maxColumns`, whose popup width and
 * estimated height are closest to a square. Provider order is preserved
 * (column-major), and the shortest columns end up on the right.
 */
export function autoProviderColumns(statuses, maxColumns = 1, options = {}) {
    const items = statuses ?? [];
    if (!items.length)
        return [];

    const maxCols = Math.max(1, Math.min(Math.trunc(Number(maxColumns) || 1), items.length));
    const popupWidth = Math.max(1, Number(options.popupWidth) || 360);
    const columnSpacing = Math.max(0, Number(options.columnSpacing) || 0);
    let best = null;

    for (let cols = 1; cols <= maxCols; cols++) {
        for (const columns of candidateColumnSplits(items, cols)) {
            const columnHeights = columns.map(column => column.reduce(
                (total, status) => total + estimateProviderHeight(status, options), 0));
            // Keep shorter columns on the right so empty space stays bottom-right.
            if (columnHeights.some((height, index) => index > 0 && columnHeights[index - 1] < height))
                continue;
            const height = Math.max(...columnHeights);
            const width = cols * popupWidth + (cols - 1) * columnSpacing;
            const score = Math.abs(width - height);
            if (!best || score < best.score || (score === best.score && height < best.height))
                best = {columns, score, height};
        }
    }

    return best ? best.columns : [items];
}

export function parseMetricOptions(options = []) {
    const grouped = new Map();
    for (const entry of options ?? []) {
        const text = String(entry);
        const separator = text.indexOf(':');
        if (separator <= 0 || separator === text.length - 1)
            continue;
        const key = text.slice(0, separator);
        const label = text.slice(separator + 1);
        if (!grouped.has(key))
            grouped.set(key, []);
        const labels = grouped.get(key);
        if (!labels.includes(label))
            labels.push(label);
    }
    return grouped;
}

export function filterVisibleMetrics(statuses, hidden = []) {
    const hiddenSet = new Set(hidden ?? []);
    return (statuses ?? []).map(status => ({
        ...status,
        metrics: (status.metrics ?? []).filter(metric =>
            !hiddenSet.has(`${status.key}:${metric.label}`)),
    }));
}

export function normalizeProviderOrder(order, allKeys = []) {
    const seen = new Set();
    const result = [];
    for (const key of order ?? []) {
        if (typeof key === 'string' && key && !seen.has(key) && (!allKeys.length || allKeys.includes(key))) {
            seen.add(key);
            result.push(key);
        }
    }
    for (const key of allKeys) {
        if (!seen.has(key)) {
            seen.add(key);
            result.push(key);
        }
    }
    return result;
}

export function orderProviderStatuses(statuses, providerOrder = []) {
    const items = statuses ?? [];
    const order = (providerOrder ?? []).filter(Boolean);
    if (!items.length || !order.length)
        return [...items];

    const rank = new Map(order.map((key, index) => [key, index]));
    return items
        .map((status, index) => ({
            status,
            rank: rank.has(status.key) ? rank.get(status.key) : order.length,
            index,
        }))
        .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
        .map(entry => entry.status);
}

export const GAUGE_START_ANGLE = (5 * Math.PI) / 6; // lower-left gap edge
export const GAUGE_END_ANGLE = (13 * Math.PI) / 6; // lower-right gap edge

/**
 * Gauge arc with a fixed 120-degree bottom opening. The green remainder is
 * anchored at the lower-left edge and grows clockwise over the top; as the
 * percentage drops it shrinks from the right edge back toward the left.
 */
export function gaugeArcAngles(pct, strokeWidth = 3, radius = 15) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    if (clamped <= 0)
        return null;
    if (clamped >= 99.95)
        return {full: true, startAngle: GAUGE_START_ANGLE, endAngle: GAUGE_END_ANGLE};

    const safeRadius = Math.max(1, radius);
    const arcSpan = GAUGE_END_ANGLE - GAUGE_START_ANGLE;
    const maxSweep = Math.max(0.2, arcSpan - (strokeWidth / safeRadius) - 0.18);
    const sweep = Math.max(0.08, (clamped / 100) * maxSweep);
    return {
        full: false,
        startAngle: GAUGE_START_ANGLE,
        endAngle: GAUGE_START_ANGLE + sweep,
    };
}

/**
 * Size of one popup ring as `_circleMeter` draws it.  Single source of truth
 * for the popup (extension.js) and the settings preview (gauge-preview.js).
 * `percentFontSize` <= 0 means "derive from the radius";
 * `percentOffsetPct` is the number's vertical offset in percent of the radius.
 */
export function popupGaugeShape(radius, percentFontSize = 0, percentOffsetPct = 0) {
    const r = Math.max(10, Math.min(32, Number(radius) || 16));
    const stroke = Math.max(2.2, Number((r * 0.19).toFixed(1)));
    const configured = Number(percentFontSize) || 0;
    const percentFont = configured > 0
        ? configured
        : Math.max(7, Number((r * 0.53).toFixed(1)));
    const offset = r * (Number(percentOffsetPct) || 0) / 100;
    const centerY = r + stroke / 2;
    const arcBottom = centerY + r * Math.sin(Math.PI / 6) + stroke / 2;
    const textBottom = centerY + offset + percentFont * 0.65;
    return {
        radius: r,
        stroke,
        percentFont,
        offset,
        centerY,
        arcBottom,
        textBottom,
        // Rows are always sized for a visible number.
        rowGaugeHeight: Math.ceil(Math.max(arcBottom, textBottom)),
    };
}

/**
 * Height of one gauge cell (ring, label and, when some visible gauge shows a
 * reset countdown, the reset row), excluding the cell padding.  Shared by the
 * popup and the settings preview so both lay out identical rows.
 */
export function widgetCellHeight({
    radius,
    spacing = 0,
    percentFontSize = 0,
    percentOffsetPct = 0,
    labelFontSize = 11,
    resetFontSize = 10,
    hasReset = true,
} = {}) {
    const shape = popupGaugeShape(radius, percentFontSize, percentOffsetPct);
    const label = Number(labelFontSize) || 11;
    const reset = Number(resetFontSize) || 10;
    return Math.ceil(shape.rowGaugeHeight + Math.max(0, Number(spacing) || 0)
        + label * 1.3 + (hasReset ? reset * 1.3 + 2 : 0) + 4);
}

export function meterFillColor(state, isRemaining = true, muted = false, insufficient = false) {
    if (insufficient)
        return [0x8a / 255, 0x8a / 255, 0x8a / 255, 1.0];
    if (muted)
        return [0x6f / 255, 0x8f / 255, 0x78 / 255, 1.0];
    if (!isRemaining)
        return [0xff / 255, 0x7b / 255, 0x72 / 255, 1.0];
    if (state === 'critical')
        return [0xff / 255, 0x7b / 255, 0x72 / 255, 1.0];
    if (state === 'warning')
        return [0xf8 / 255, 0xe4 / 255, 0x5c / 255, 1.0];
    return [0x8f / 255, 0xf0 / 255, 0xa4 / 255, 1.0];
}

/**
 * Gauge labels double as persistent settings keys (`hidden-metrics`,
 * `metric-options`, popup-layout `order`).  Whenever a provider renames a
 * label, add the old spelling here so saved settings follow the rename
 * instead of silently resetting.
 *
 * LEGACY_LABEL_ALIASES: exact old label -> current label, per provider key.
 * LEGACY_LABEL_PATTERNS: for labels built from dynamic text such as a model
 * name; each rule is [RegExp, replacement] applied with String.replace.
 */
export const LEGACY_LABEL_ALIASES = {
    gemini: {
        'Claude/GPT 5h': 'C/C 5h',
        'Claude/GPT 7d': 'C/C 7d',
    },
    go: {
        Weekly: '7d',
        Monthly: '30d',
    },
};

export const LEGACY_LABEL_PATTERNS = {
    // '7d Sonnet' -> 'Sonnet 7d'.  A bare number after '7d' is the
    // duplicate-label suffix ('7d 2'), not a model name.
    claude: [[/^7d (?!\d+$)(.+)$/, '$1 7d']],
};

/** Current spelling of a (possibly legacy) gauge label for a provider. */
export function migrateMetricLabel(provider, label) {
    if (typeof label !== 'string')
        return label;
    const alias = LEGACY_LABEL_ALIASES[provider]?.[label];
    if (alias !== undefined)
        return alias;
    for (const [pattern, replacement] of LEGACY_LABEL_PATTERNS[provider] ?? []) {
        if (pattern.test(label))
            return label.replace(pattern, replacement);
    }
    return label;
}

/** Migrate `provider:label` entries (hidden-metrics / metric-options), de-duplicated. */
export function migrateMetricEntries(entries) {
    const result = [];
    const seen = new Set();
    for (const entry of entries ?? []) {
        const text = String(entry);
        const separator = text.indexOf(':');
        const migrated = separator > 0
            ? `${text.slice(0, separator)}:${migrateMetricLabel(text.slice(0, separator), text.slice(separator + 1))}`
            : text;
        if (!seen.has(migrated)) {
            seen.add(migrated);
            result.push(migrated);
        }
    }
    return result;
}

/**
 * Migrate the per-provider `order` arrays inside a popup-layout JSON string.
 * Returns the input unchanged when nothing needs rewriting or it is invalid.
 */
export function migrateLayoutJson(raw) {
    if (!raw || typeof raw !== 'string')
        return raw;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_error) {
        return raw;
    }
    if (!parsed || !Array.isArray(parsed.providers))
        return raw;
    let changed = false;
    for (const entry of parsed.providers) {
        if (!entry || typeof entry.id !== 'string' || !Array.isArray(entry.order))
            continue;
        const order = [...new Set(entry.order.map(label => migrateMetricLabel(entry.id, label)))];
        if (order.length !== entry.order.length || order.some((label, index) => label !== entry.order[index])) {
            entry.order = order;
            changed = true;
        }
    }
    return changed ? JSON.stringify(parsed) : raw;
}

/**
 * Merge freshly reported gauge options into the remembered `metric-options`.
 * Providers in `statuses` that returned fresh metrics replace their entries;
 * providers that are present but failed (or reported nothing) keep what was
 * remembered; providers no longer in `statuses` are pruned.  An empty status
 * set leaves the remembered list alone.
 */
export function mergeMetricOptions(current, statuses) {
    if (!(statuses ?? []).length)
        return [...(current ?? [])];
    const previous = parseMetricOptions(migrateMetricEntries(current));
    const fresh = new Map();
    const keys = [];
    for (const status of statuses) {
        if (!keys.includes(status.key))
            keys.push(status.key);
        if (status.state !== 'ok')
            continue;
        for (const metric of status.metrics ?? []) {
            if (!metric.label)
                continue;
            if (!fresh.has(status.key))
                fresh.set(status.key, []);
            const labels = fresh.get(status.key);
            if (!labels.includes(metric.label))
                labels.push(metric.label);
        }
    }
    const result = [];
    for (const key of keys) {
        for (const label of fresh.get(key) ?? previous.get(key) ?? [])
            result.push(`${key}:${label}`);
    }
    return result;
}
