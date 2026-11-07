// Regressions for the GNOME extension helpers introduced after the PR #4
// review: credential-file parsing must match the Python loaders (F7), reset
// display must tolerate providers missing from the schema (F1), and the
// provider lists in extension.js/prefs.js must stay consistent with the
// schema (F1).

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

function loadModule(name) {
    const source = readFileSync(
        new URL(`../gnome-shell-extension/${name}`, import.meta.url),
        'utf8',
    );
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const {resetText, resetTextGlobal, shouldShowReset, shouldShowResetGlobal} = await loadModule('reset-display.js');
const {providerPlan, providerUser} = await loadModule('provider-header.js');
const {
    autoProviderColumns,
    chunkCircleMetrics,
    chunkProviderColumns,
    circlePercentText,
    displayMetricValue,
    gaugeArcAngles,
    GAUGE_END_ANGLE,
    GAUGE_START_ANGLE,
    estimateProviderHeight,
    filterVisibleMetrics,
    headerSpacingKeyForStyle,
    isPercentageMetric,
    meterFillColor,
    normalizeCircleTextPosition,
    normalizeMeterStyle,
    normalizeProviderOrder,
    orderProviderStatuses,
    paddingKeyForStyle,
    parseMetricOptions,
    providerColumnsHeight,
    spacingKeyForStyle,
} = await loadModule('meter-layout.js');

// --- F1: reset display tolerates providers missing from the schema ---

function prefsFor(knownKeys, values = {}) {
    return {
        has: key => knownKeys.includes(key),
        getBoolean: key => values[key] ?? false,
    };
}

test('schema-unknown provider renders text metrics without touching gsettings', () => {
    const prefs = prefsFor(['show-reset-when-full-claude']);
    const moonshotMetric = {label: 'Balance', value: '$4.20', pct: null, reset: '—'};
    assert.equal(shouldShowReset(prefs, moonshotMetric, 'moonshot'), false);
    assert.equal(resetText(prefs, moonshotMetric, 'moonshot'), '—');
});

test('schema-unknown provider with a full percentage falls back to no reset', () => {
    const prefs = prefsFor([], {'show-reset-when-full-moonshot': true});
    const metric = {label: 'Credits', value: '100%', pct: 100, reset: '—'};
    // The key exists in neither the schema (has() is false) nor gsettings.
    assert.equal(shouldShowReset(prefs, metric, 'moonshot'), false);
    assert.equal(resetText(prefs, metric, 'moonshot'), '—');
});

test('known provider honours the show-reset-when-full preference', () => {
    const key = 'show-reset-when-full-claude';
    const full = {label: '7d', value: '100%', pct: 99.96, reset: '—'};
    assert.equal(shouldShowReset(prefsFor([key], {[key]: true}), full, 'claude'), true);
    assert.equal(resetText(prefsFor([key], {[key]: true}), full, 'claude'), 'No reset scheduled');
    assert.equal(shouldShowReset(prefsFor([key], {[key]: false}), full, 'claude'), false);
    assert.equal(resetText(prefsFor([key], {[key]: false}), full, 'claude'), '—');
});

test('metrics with a scheduled reset always show it', () => {
    const prefs = prefsFor([]);
    const metric = {label: '5h', value: '20%', pct: 20, reset: 'in 3h'};
    assert.equal(shouldShowReset(prefs, metric, 'codex'), true);
    assert.equal(resetText(prefs, metric, 'codex'), 'in 3h');
});

// --- popup header user-information switch ---

const accountStatus = {
    key: 'claude',
    name: 'Claude',
    plan: 'Max 5x',
    user: 'person@example.com',
    source: 'browser cookies',
};

test('provider plan replaces the provider name and can hide org names', () => {
    assert.equal(providerPlan(accountStatus), 'Max 5x');
    assert.equal(
        providerPlan({key: 'claude', name: 'Claude', plan: 'Team (Elsa Lab)'}),
        'Team (Elsa Lab)',
    );
    assert.equal(
        providerPlan({key: 'claude', plan: 'Team (Elsa Lab)'}, false),
        'Team',
    );
    assert.equal(
        providerPlan({key: 'codex', plan: 'Business (Studio)'}, false),
        'Business',
    );
    // Only Claude and Codex strip workspace suffixes.
    assert.equal(providerPlan({key: 'go', plan: 'Team (Studio)'}, false), 'Team (Studio)');
    assert.equal(providerPlan({key: 'gemini', plan: '', name: 'Gemini'}), 'Gemini');
    assert.equal(providerPlan({plan: null, name: null}), '');
});

test('provider user is shown only when user information is enabled', () => {
    assert.equal(providerUser(accountStatus, true), 'person@example.com');
    assert.equal(providerUser(accountStatus), 'person@example.com');
    assert.equal(providerUser(accountStatus, false), '');
    assert.equal(providerUser({}, true), '');
    assert.equal(providerUser({plan: 'Pro', user: null, source: 'account'}, true), '');
});

test('header rendering never mutates the provider payload', () => {
    const status = {
        key: 'codex',
        name: 'Codex',
        plan: 'Plus',
        user: 'a@b.c',
        source: 'browser cookies',
        metrics: [{label: '7d', value: '80%'}],
    };
    const snapshot = JSON.stringify(status);
    providerPlan(status, true);
    providerPlan(status, false);
    providerUser(status, true);
    providerUser(status, false);
    assert.equal(JSON.stringify(status), snapshot);
});

// --- F1: provider lists stay consistent with the schema ---

const extensionDir = new URL('../gnome-shell-extension/', import.meta.url);
const extensionSource = readFileSync(new URL('extension.js', extensionDir), 'utf8');
const prefsSource = readFileSync(new URL('prefs.js', extensionDir), 'utf8');
const webDir = new URL('web-settings/', extensionDir);
const webSource = ['appearance.js', 'gauge-preview.js', 'layout-editor.js', 'providers.js', 'store.js', 'ui.js']
    .map(name => readFileSync(new URL(name, webDir), 'utf8')).join('\n');
const providersConfig = JSON.parse(readFileSync(new URL('providers.json', webDir), 'utf8'));
const schema = readFileSync(
    new URL('schemas/org.gnome.shell.extensions.agent-quota.gschema.xml', extensionDir),
    'utf8',
);

function listLiteral(source, name) {
    const match = source.match(String.raw`const ${name} = (?:new Set\()?\[([^\]]*)\]`);
    assert.ok(match, `${name} not found`);
    return match[1].split(',').map(item => item.trim().replaceAll("'", ''));
}

function providerIds(source) {
    const match = source.match(/const PROVIDERS = \[([\s\S]*?)\];/);
    assert.ok(match, 'PROVIDERS not found');
    return [...match[1].matchAll(/id: '([^']+)'/g)].map(match => match[1]);
}

const providerKeys = listLiteral(extensionSource, 'PROVIDER_KEYS');
const prefsIds = providersConfig.providers.map(provider => provider.id);
const defaultProviders = schema.match(/<key name="providers"[\s\S]*?<default>([^<]*)<\/default>/)[1];

test('every extension provider has a reset schema key and default entry', () => {
    assert.ok(providerKeys.includes('moonshot'));
    for (const key of providerKeys) {
        assert.ok(
            schema.includes(`name="show-reset-when-full-${key}"`),
            `schema lacks show-reset-when-full-${key}`,
        );
        assert.ok(defaultProviders.includes(`'${key}'`), `providers default lacks ${key}`);
    }
});

test('preferences cover every extension provider', () => {
    for (const key of providerKeys)
        assert.ok(prefsIds.includes(key), `prefs PROVIDERS lacks ${key}`);
});

test('cookie-browser keys only exist for providers that honour --browser', () => {
    const browserKeys = listLiteral(extensionSource, 'BROWSER_PROVIDER_KEYS');
    assert.ok(!browserKeys.includes('go'), 'Go no longer uses cookie auth');
    for (const key of browserKeys)
        assert.ok(schema.includes(`name="browser-${key}"`), `schema lacks browser-${key}`);
    assert.ok(!schema.includes('name="browser-go"'));
    assert.ok(!schema.includes('name="compact-go-user"'));
});

// --- show-user-info: default-on schema key, preferences switch, and wiring ---

test('show-user-info schema key defaults to true', () => {
    const match = schema.match(/<key name="show-user-info" type="b">([\s\S]*?)<\/key>/);
    assert.ok(match, 'schema lacks show-user-info');
    assert.match(match[1], /<default>true<\/default>/);
    assert.match(match[1], /<summary>[^<]+<\/summary>/);
});

test('web settings expose Show user information under Appearance → Popup', () => {
    assert.match(webSource, /'show-user-info'/);
    assert.match(webSource, /Show user information/);
});

test('extension renders headers through provider-header.js and the settings', () => {
    assert.match(extensionSource, /import \{providerPlan, providerUser\} from '\.\/provider-header\.js';/);
    assert.match(extensionSource, /get_boolean\('show-user-info'\)/);
    assert.match(extensionSource, /get_boolean\('show-org-name'\)/);
    assert.match(extensionSource, /providerPlan\(status, showOrgName\)/);
    assert.match(extensionSource, /providerUser\(status, showUserInfo\)/);
    assert.ok(!/function displayUser\(/.test(extensionSource), 'displayUser must live in provider-header.js');
    // The generic `changed` fallback rerenders from the cached payload; the
    // switch must not trigger a provider refetch.
    assert.ok(!extensionSource.includes("key === 'show-user-info'"));
    assert.ok(!extensionSource.includes("key === 'show-org-name'"));
});

// --- meter-style: circular progress layout helpers, schema, and preferences ---

test('normalizeMeterStyle defaults to circle and accepts bar', () => {
    assert.equal(normalizeMeterStyle('circle'), 'circle');
    assert.equal(normalizeMeterStyle('bar'), 'bar');
    assert.equal(normalizeMeterStyle(''), 'circle');
    assert.equal(normalizeMeterStyle(null), 'circle');
    assert.equal(normalizeMeterStyle(undefined), 'circle');
    assert.equal(normalizeMeterStyle('unknown'), 'circle');
});

test('normalizeCircleTextPosition defaults to below and accepts right', () => {
    assert.equal(normalizeCircleTextPosition('below'), 'below');
    assert.equal(normalizeCircleTextPosition('right'), 'right');
    assert.equal(normalizeCircleTextPosition(''), 'below');
    assert.equal(normalizeCircleTextPosition(null), 'below');
    assert.equal(normalizeCircleTextPosition(undefined), 'below');
});

test('isPercentageMetric distinguishes numeric percentages from text-only balances', () => {
    assert.equal(isPercentageMetric({label: '5h', value: '0%', pct: 0}), true);
    assert.equal(isPercentageMetric({label: '7d', value: '100%', pct: 100}), true);
    assert.equal(isPercentageMetric({label: 'Balance', value: '$4.20', pct: null}), false);
    assert.equal(isPercentageMetric({label: 'Balance', value: '$4.20'}), false);
    assert.equal(isPercentageMetric(null), false);
});

test('chunkCircleMetrics packs compact 3-window providers into a single 3-column row', () => {
    const claudeMetrics = [
        {label: '5h', value: '100%', pct: 100},
        {label: '7d', value: '89%', pct: 89},
        {label: 'Fable 7d', value: '89%', pct: 89},
    ];
    const rows = chunkCircleMetrics(claudeMetrics);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].map(m => m.label), ['5h', '7d', 'Fable 7d']);
});

test('chunkCircleMetrics arranges metrics in column-major order across configured columns', () => {
    const geminiMetrics = [
        {label: 'Gemini 5h', value: '99%', pct: 99},
        {label: 'C/C 5h', value: '100%', pct: 100},
        {label: 'Gemini 7d', value: '99%', pct: 99},
        {label: 'C/C 7d', value: '100%', pct: 100},
        {label: 'Argon 7d', value: '90%', pct: 90},
    ];
    assert.deepEqual(
        chunkCircleMetrics(geminiMetrics, 3).map(row => row.map(m => m.label)),
        [
            ['Gemini 5h', 'Gemini 7d', 'Argon 7d'],
            ['C/C 5h', 'C/C 7d'],
        ],
    );
    assert.deepEqual(
        chunkCircleMetrics(geminiMetrics, 2).map(row => row.map(m => m.label)),
        [
            ['Gemini 5h', 'C/C 7d'],
            ['C/C 5h', 'Argon 7d'],
            ['Gemini 7d'],
        ],
    );
    assert.deepEqual(
        chunkCircleMetrics(geminiMetrics, 1).map(row => row.length),
        [1, 1, 1, 1, 1],
    );
});

test('chunkCircleMetrics skips non-percentage metrics', () => {
    const mixed = [
        {label: 'Balance', value: '$10.00', pct: null},
    ];
    assert.deepEqual(chunkCircleMetrics(mixed), []);
});

test('chunkProviderColumns splits providers by column count or explicit break keys', () => {
    const statuses = [
        {key: 'claude'},
        {key: 'codex'},
        {key: 'zai'},
        {key: 'gemini'},
        {key: 'go'},
    ];
    assert.deepEqual(
        chunkProviderColumns(statuses, 1, []).map(col => col.map(s => s.key)),
        [['claude', 'codex', 'zai', 'gemini', 'go']],
    );
    assert.deepEqual(
        chunkProviderColumns(statuses, 2, []).map(col => col.map(s => s.key)),
        [
            ['claude', 'codex', 'zai'],
            ['gemini', 'go'],
        ],
    );
    assert.deepEqual(
        chunkProviderColumns(statuses, 1, ['zai', 'go']).map(col => col.map(s => s.key)),
        [
            ['claude', 'codex'],
            ['zai', 'gemini'],
            ['go'],
        ],
    );
});

const gridStatus = key => ({
    key,
    metrics: Array.from({length: 4}, (_, index) => ({label: `m${index}`, pct: 50})),
});
const gridOptions = {
    meterStyle: 'bar',
    circleColumns: 3,
    circleRadius: 16,
    circleTextPosition: 'below',
    padding: 8,
    headerSpacing: 8,
    spacing: 6,
    popupWidth: 200,
    columnSpacing: 20,
};

test('autoProviderColumns preserves order and leaves empty cells bottom-right', () => {
    const statuses = ['claude', 'codex', 'zai', 'gemini', 'go'].map(gridStatus);
    const columns = autoProviderColumns(statuses, 3, gridOptions);

    assert.deepEqual(columns.flat().map(status => status.key), statuses.map(status => status.key));
    assert.ok(columns.length <= 3);
    for (let index = 1; index < columns.length; index++)
        assert.ok(columns[index - 1].length >= columns[index].length);
    // Independent columns keep empty space at the bottom-right: earlier
    // columns must be at least as tall as later ones.
    const heights = columns.map(column => column.reduce(
        (total, status) => total + estimateProviderHeight(status, gridOptions), 0));
    for (let index = 1; index < heights.length; index++)
        assert.ok(heights[index - 1] >= heights[index]);
});

test('autoProviderColumns picks the column count closest to a square', () => {
    const statuses = ['claude', 'codex', 'zai', 'gemini', 'go'].map(gridStatus);
    // 2 columns is the only split whose width and estimated height are close.
    assert.equal(autoProviderColumns(statuses, 3, gridOptions).length, 2);
    assert.deepEqual(
        autoProviderColumns(statuses, 1, gridOptions).map(column => column.map(status => status.key)),
        [statuses.map(status => status.key)],
    );
});

test('provider height estimates grow with the number of metrics', () => {
    const empty = {key: 'empty', metrics: []};
    const one = {key: 'one', metrics: [{label: '5h', pct: 50}]};
    const four = gridStatus('four');

    assert.ok(estimateProviderHeight(one, gridOptions) > estimateProviderHeight(empty, gridOptions));
    assert.ok(estimateProviderHeight(four, gridOptions) > estimateProviderHeight(one, gridOptions));
    assert.equal(providerColumnsHeight([[four, one]], gridOptions), estimateProviderHeight(four, gridOptions) + estimateProviderHeight(one, gridOptions));
});

test('parseMetricOptions groups detected bars by provider', () => {
    const grouped = parseMetricOptions([
        'claude:5h',
        'claude:7d',
        'codex:5h',
        'claude:5h',
        'bad-entry',
        'empty:',
    ]);
    assert.deepEqual([...grouped.keys()], ['claude', 'codex']);
    assert.deepEqual(grouped.get('claude'), ['5h', '7d']);
    assert.deepEqual(grouped.get('codex'), ['5h']);
});

test('filterVisibleMetrics hides provider:label entries only', () => {
    const statuses = [
        {key: 'claude', metrics: [{label: '5h'}, {label: '7d'}]},
        {key: 'codex', metrics: [{label: '5h'}]},
    ];
    const visible = filterVisibleMetrics(statuses, ['claude:7d', 'codex:missing']);
    assert.deepEqual(visible[0].metrics.map(metric => metric.label), ['5h']);
    assert.deepEqual(visible[1].metrics.map(metric => metric.label), ['5h']);
    // The original payload is not mutated.
    assert.deepEqual(statuses[0].metrics.map(metric => metric.label), ['5h', '7d']);
});

test('normalizeProviderOrder and orderProviderStatuses sort providers while preserving multi-workspace order', () => {
    assert.deepEqual(
        normalizeProviderOrder(['gemini', 'claude'], ['claude', 'codex', 'gemini', 'go']),
        ['gemini', 'claude', 'codex', 'go'],
    );
    const statuses = [
        {key: 'claude', workspace_id: ''},
        {key: 'codex', workspace_id: 'ws-1'},
        {key: 'codex', workspace_id: 'ws-2'},
        {key: 'gemini', workspace_id: ''},
    ];
    assert.deepEqual(
        orderProviderStatuses(statuses, ['gemini', 'codex', 'claude']).map(s => `${s.key}:${s.workspace_id}`),
        ['gemini:', 'codex:ws-1', 'codex:ws-2', 'claude:'],
    );
    assert.deepEqual(
        orderProviderStatuses(statuses, []).map(s => `${s.key}:${s.workspace_id}`),
        ['claude:', 'codex:ws-1', 'codex:ws-2', 'gemini:'],
    );
});

test('meterFillColor returns palette RGBA tuples for ok, warning, critical, and muted states', () => {
    assert.equal(meterFillColor('ok', true, false).length, 4);
    assert.notDeepEqual(meterFillColor('ok', true, false), meterFillColor('warning', true, false));
    assert.notDeepEqual(meterFillColor('warning', true, false), meterFillColor('critical', true, false));
    assert.deepEqual(meterFillColor('ok', false, false), meterFillColor('critical', true, false));
    assert.notDeepEqual(meterFillColor('ok', true, true), meterFillColor('ok', true, false));
});

test('meterFillColor returns neutral gray for an insufficient balance', () => {
    assert.deepEqual(
        meterFillColor('ok', true, false, true),
        [0x8a / 255, 0x8a / 255, 0x8a / 255, 1.0],
    );
    assert.notDeepEqual(
        meterFillColor('ok', true, true, true),
        meterFillColor('ok', true, true, false),
    );
});

test('circlePercentText floors percentages and honours display modes', () => {
    assert.equal(circlePercentText(100), '100%');
    assert.equal(circlePercentText(89.4), '89%');
    assert.equal(circlePercentText(27.68), '27%');
    assert.equal(circlePercentText(-5), '0%');
    assert.equal(circlePercentText(120), '100%');
    assert.equal(circlePercentText(99.6, 'number'), '99');
    assert.equal(circlePercentText(99.6, 'hidden'), '');
    assert.equal(circlePercentText(99.6, 'bogus'), '99%');
});

test('displayMetricValue floors percentage values but keeps amounts', () => {
    assert.equal(displayMetricValue({label: '5h', value: '99.7%', pct: 99.7}), '99%');
    assert.equal(displayMetricValue({label: '7d', value: '100%', pct: 100}), '100%');
    assert.equal(displayMetricValue({label: 'Credits', value: '1.87 / 10', pct: 19}), '1.87 / 10');
    assert.equal(displayMetricValue({label: 'Credits', value: '0 credits', pct: null}), '0 credits');
});

test('gaugeArcAngles keeps the bottom opening fixed and shrinks the remainder', () => {
    assert.equal(gaugeArcAngles(0), null);
    assert.deepEqual(gaugeArcAngles(100), {
        full: true,
        startAngle: GAUGE_START_ANGLE,
        endAngle: GAUGE_END_ANGLE,
    });

    const arc90 = gaugeArcAngles(90);
    const arc50 = gaugeArcAngles(50);
    const arc28 = gaugeArcAngles(28);
    assert.equal(arc90.full, false);
    assert.equal(arc90.startAngle, GAUGE_START_ANGLE);
    assert.equal(arc50.startAngle, GAUGE_START_ANGLE);
    assert.equal(arc28.startAngle, GAUGE_START_ANGLE);
    // As remaining quota drops, the arc shrinks from the right edge back
    // toward the fixed lower-left end of the opening.
    assert.ok(arc90.endAngle > arc50.endAngle);
    assert.ok(arc50.endAngle > arc28.endAngle);
    assert.ok(arc28.startAngle < arc28.endAngle);
    assert.ok(arc90.endAngle - arc90.startAngle < GAUGE_END_ANGLE - GAUGE_START_ANGLE);
});

test('paddingKeyForStyle, headerSpacingKeyForStyle, and spacingKeyForStyle keep separate keys for circle and bar', () => {
    assert.equal(paddingKeyForStyle('circle'), 'circle-provider-padding');
    assert.equal(paddingKeyForStyle('bar'), 'provider-padding');
    assert.equal(headerSpacingKeyForStyle('circle'), 'circle-header-spacing');
    assert.equal(headerSpacingKeyForStyle('bar'), 'header-spacing');
    assert.equal(spacingKeyForStyle('circle'), 'circle-metric-spacing');
    assert.equal(spacingKeyForStyle('bar'), 'metric-spacing');
    assert.ok(schema.includes('name="circle-provider-padding"'));
    assert.ok(schema.includes('name="header-spacing"'));
    assert.ok(schema.includes('name="circle-header-spacing"'));
    assert.ok(schema.includes('name="circle-metric-spacing"'));
    assert.ok(schema.includes('name="circle-radius"'));
    assert.ok(schema.includes('name="circle-columns"'));
    assert.ok(schema.includes('name="provider-order"'));
    assert.ok(schema.includes('name="provider-columns"'));
    assert.ok(schema.includes('name="provider-layout"'));
    assert.ok(schema.includes('name="gauge-percent"'));
    assert.ok(schema.includes('name="gauge-percent-offset"'));
    assert.ok(schema.includes('name="gauge-percent-font-size"'));
    assert.ok(schema.includes('name="gauge-label-font-size"'));
    assert.ok(schema.includes('name="gauge-reset-font-size"'));
    assert.ok(schema.includes('name="show-org-name"'));
    assert.ok(schema.includes('name="metric-options"'));
    assert.ok(schema.includes('name="hidden-metrics"'));
    assert.ok(schema.includes('name="provider-column-spacing"'));
    assert.ok(schema.includes('name="provider-column-breaks"'));
    assert.ok(schema.includes('name="circle-text-position"'));
});

test('legacy provider-layout key remains only for the silent fallback', () => {
    const match = schema.match(/<key name="provider-layout" type="s">([\s\S]*?)<\/key>/);
    assert.ok(match, 'schema lacks provider-layout');
    assert.match(match[1], /<default>'manual'<\/default>/);
    assert.ok(!prefsSource.includes('addProviderLayout'));
    assert.match(extensionSource, /get_string\('provider-layout'\)/);
    assert.match(extensionSource, /autoProviderColumns\(statuses, providerColumns/);
});

test('gauge-percent and show-org-name schema keys are wired into prefs and extension', () => {
    const gauge = schema.match(/<key name="gauge-percent" type="s">([\s\S]*?)<\/key>/);
    assert.ok(gauge, 'schema lacks gauge-percent');
    assert.match(gauge[1], /<default>'percent'<\/default>/);
    assert.match(gauge[1], /<choice value="hidden"\/>/);
    assert.match(webSource, /Number inside rings/);
    assert.match(extensionSource, /get_string\('gauge-percent'\)/);
    assert.match(extensionSource, /get_int\('gauge-percent-offset'\)/);
    assert.match(extensionSource, /get_int\('gauge-percent-font-size'\)/);
    assert.match(extensionSource, /get_int\('gauge-label-font-size'\)/);
    assert.match(extensionSource, /get_int\('gauge-reset-font-size'\)/);
    assert.match(webSource, /gauge-percent-offset/);
    assert.match(webSource, /gauge-percent-font-size/);
    assert.match(webSource, /gauge-label-font-size/);
    assert.match(webSource, /gauge-reset-font-size/);
    assert.match(webSource, /Hidden gauges/);
    assert.match(extensionSource, /filterVisibleMetrics\(/);
    assert.match(extensionSource, /_rememberMetricOptions\(/);
    assert.match(extensionSource, /agent-quota-provider-columns/);
    assert.ok(!extensionSource.includes('zipProviderRows'));

    const org = schema.match(/<key name="show-org-name" type="b">([\s\S]*?)<\/key>/);
    assert.ok(org, 'schema lacks show-org-name');
    assert.match(org[1], /<default>true<\/default>/);
    assert.match(extensionSource, /get_boolean\('show-org-name'\)/);
    assert.match(extensionSource, /providerPlan\(status, showOrgName\)/);
});

test('bar mode is no longer exposed in preferences', () => {
    const match = schema.match(/<key name="meter-style" type="s">([\s\S]*?)<\/key>/);
    assert.ok(match, 'legacy meter-style key should remain for fallback');
    assert.match(match[1], /<default>'circle'<\/default>/);
    assert.ok(!prefsSource.includes('addMeterStyle'));
    assert.ok(!prefsSource.includes('Progress style'));
    // The hidden classic fallback is gauge-only too.
    assert.ok(!extensionSource.includes("get_string('meter-style')"));
    assert.match(extensionSource, /meterStyle = 'circle'/);
});

// --- widget-style global grid ---

test('widget layout schema and renderer are wired', () => {
    assert.match(schema, /<key name="popup-layout" type="s">/);
    assert.match(schema, /<key name="layout-columns" type="i">/);
    assert.match(schema, /<key name="layout-gap" type="i">/);
    assert.match(schema, /<key name="layout-padding" type="i">/);
    assert.match(schema, /<key name="layout-gauge-spacing" type="i">/);
    assert.match(webSource, /renderLayout/);
    assert.match(webSource, /layout-padding/);
    assert.match(webSource, /layout-gauge-spacing/);
    assert.match(extensionSource, /get_int\('layout-padding'\)/);
    assert.match(extensionSource, /get_int\('layout-gauge-spacing'\)/);
    assert.match(webSource, /gaugeArcAngles\(/);
    assert.match(webSource, /moveGauge\(/);
    assert.match(webSource, /parseLayout\(/);
    assert.match(webSource, /saveLayout\(/);
    assert.match(extensionSource, /parseLayout\(/);
    assert.match(extensionSource, /layoutGrid\(/);
    assert.match(extensionSource, /agent-quota-widget-card/);
    assert.match(extensionSource, /Clutter\.FixedLayout/);
    // Layout-only: no user-facing classic switch and no bar mode.
    assert.ok(!prefsSource.includes('Use widget layout'));
    assert.ok(!prefsSource.includes('addMeterStyle'));
    assert.ok(!prefsSource.includes('Progress style'));
    assert.ok(!prefsSource.includes('addProviderLayout'));
    assert.ok(!extensionSource.includes("get_string('popup-layout')\n            &&"));
});

test('widget layout uses one global reset rule', () => {
    const prefs = {getBoolean: key => key === 'show-reset-when-full-global'};
    const full = {label: '7d', value: '100%', pct: 99.97, reset: '—'};
    assert.equal(shouldShowResetGlobal(prefs, full), true);
    assert.equal(resetTextGlobal(prefs, full), '-');
    const scheduled = {label: '5h', value: '20%', pct: 20, reset: 'in 2h'};
    assert.equal(shouldShowResetGlobal(prefs, scheduled), true);
    assert.equal(resetTextGlobal(prefs, scheduled), 'in 2h');
    assert.equal(shouldShowResetGlobal({getBoolean: () => false}, full), false);
});

test('widget reset text collapses no-reset sentences to a dash', () => {
    const prefs = {getBoolean: () => true};
    const planned = {label: '7d', value: '100%', pct: 100, reset: 'No reset planned'};
    assert.equal(resetTextGlobal(prefs, planned), '-');
    const scheduled = {label: '7d', value: '100%', pct: 100, reset: 'No reset scheduled'};
    assert.equal(resetTextGlobal(prefs, scheduled), '-');
    const missing = {label: '7d', value: '100%', pct: 100, reset: '—'};
    assert.equal(resetTextGlobal(prefs, missing), '-');
});

test('extension seeds initial popup item and enforces subprocess timeout', () => {
    assert.ok(extensionSource.includes('Loading quotas…'));
    assert.ok(extensionSource.includes('SUBPROCESS_TIMEOUT_SECONDS'));
    assert.ok(extensionSource.includes('Promise.allSettled('));
    assert.ok(!extensionSource.includes('Promise.all('));
});
