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

// reset-display.js imports meter-layout.js, so load it from disk (a data: URL cannot resolve relative imports).
const {resetText, resetTextGlobal, shouldShowReset, shouldShowResetGlobal} =
    await import('../gnome-shell-extension/reset-display.js');
const {providerFailureMessage, providerPlan, providerUser} = await loadModule('provider-header.js');
const {
    circlePercentText,
    displayMetricValue,
    gaugeArcAngles,
    GAUGE_END_ANGLE,
    GAUGE_START_ANGLE,
    constrainThresholdEdit,
    createMetricLabelMigrator,
    filterVisibleMetrics,
    flooredPercent,
    isFullPercent,
    isPercentageMetric,
    mergeMetricOptions,
    mergeWorkspaceOptions,
    MAX_REMEMBERED_WORKSPACES,
    meterFillColor,
    migrateMetricLabel,
    normalizeProviderOrder,
    normalizeThresholds,
    orderProviderStatuses,
    parseMetricOptions,
    parseWorkspaceOptions,
    thresholdState,
} = await loadModule('meter-layout.js');
const {gaugeTone} = await import('../gnome-shell-extension/web-settings/gauge-preview.js');

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
    const full = {label: '7d', value: '100%', pct: 100, reset: '—'};
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

test('providerFailureMessage is independent of the user label', () => {
    const failed = {key: 'codex', state: 'auth_err', error: 'token expired', user: 'me@example.com'};
    // The user label being shown or hidden never changes the failure text.
    assert.equal(providerUser(failed, true), 'me@example.com');
    assert.equal(providerFailureMessage(failed), 'token expired');
    assert.equal(providerUser(failed, false), '');
    assert.equal(providerFailureMessage(failed), 'token expired');
    assert.equal(providerFailureMessage({...failed, state: 'ok'}), '');
    assert.equal(providerFailureMessage({...failed, error: ''}), '');
    assert.equal(providerFailureMessage(null), '');
});

test('extension renders headers through provider-header.js and the settings', () => {
    assert.match(extensionSource, /import \{providerFailureMessage, providerPlan, providerUser\} from '\.\/provider-header\.js';/);
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

// --- circular gauge helpers, schema, and preferences ---

test('isPercentageMetric distinguishes numeric percentages from text-only balances', () => {
    assert.equal(isPercentageMetric({label: '5h', value: '0%', pct: 0}), true);
    assert.equal(isPercentageMetric({label: '7d', value: '100%', pct: 100}), true);
    assert.equal(isPercentageMetric({label: 'Balance', value: '$4.20', pct: null}), false);
    assert.equal(isPercentageMetric({label: 'Balance', value: '$4.20'}), false);
    assert.equal(isPercentageMetric(null), false);
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

test('live gauge schema keys remain and the removed bar/classic keys are gone', () => {
    for (const key of ['circle-radius', 'circle-metric-spacing', 'provider-order', 'gauge-percent',
        'gauge-percent-offset', 'gauge-percent-font-size', 'gauge-label-font-size',
        'gauge-reset-font-size', 'show-org-name', 'metric-options', 'hidden-metrics'])
        assert.ok(schema.includes(`name="${key}"`), `schema lacks ${key}`);
    // No UI and no reader after the classic column fallback was removed.
    for (const key of ['meter-style', 'provider-columns', 'provider-layout', 'provider-column-breaks',
        'provider-column-spacing', 'circle-columns', 'popup-width', 'provider-padding', 'header-spacing',
        'metric-spacing', 'circle-provider-padding', 'circle-header-spacing', 'circle-text-position']) {
        assert.ok(!schema.includes(`name="${key}"`), `schema still has ${key}`);
        assert.ok(!extensionSource.includes(`'${key}'`), `extension.js still reads ${key}`);
    }
    assert.ok(!extensionSource.includes('_buildProviderBox'));
    assert.ok(!extensionSource.includes('chunkProviderColumns'));
    assert.ok(!extensionSource.includes('_renderMetrics'));
    assert.match(extensionSource, /get_int\('circle-metric-spacing'\)/);
    assert.ok(!prefsSource.includes('addMeterStyle'));
    assert.ok(!prefsSource.includes('addProviderLayout'));
});

test('a throwing widget renderer leaves an error row instead of a blank popup', () => {
    assert.match(extensionSource, /_replaceMenu\('Cannot render quotas'/);
    assert.match(extensionSource, /logError\(error, 'agent-quota: widget layout failed'\)/);
});

test('remembered Codex workspaces are stored before the layout migration and drive both paths', () => {
    const render = extensionSource.slice(extensionSource.indexOf('    _renderPayload(payload) {'));
    const remember = render.indexOf('this._rememberCodexWorkspaces(statuses)');
    const migrate = render.indexOf('this._migrateWorkspaceLayoutIds()');
    assert.ok(remember >= 0 && migrate > remember, 'migration must run after remembering workspaces');
    // The migration reads the remembered list, not the filtered statuses.
    const body = extensionSource.slice(extensionSource.indexOf('    _migrateWorkspaceLayoutIds() {'));
    assert.match(body.slice(0, 900), /get_strv\('codex-workspace-options'\)/);
    assert.match(body.slice(0, 900), /migrateBareProviderLayoutJson\(current, 'codex', remembered\)/);
    assert.match(extensionSource, /expandFailedWorkspaceStatuses\(/);
});

test('parseWorkspaceOptions reads the stored JSON entries in order and skips bad ones', () => {
    assert.deepEqual(
        parseWorkspaceOptions([
            JSON.stringify({id: 'ws-A', label: 'Team · a'}),
            'not json',
            JSON.stringify({id: '', label: 'x'}),
            JSON.stringify({id: 'ws-B'}),
            JSON.stringify({id: 'ws-C', label: 7}),
        ]),
        [{id: 'ws-A', label: 'Team · a'}, {id: 'ws-B', label: ''}, {id: 'ws-C', label: ''}],
    );
    assert.deepEqual(parseWorkspaceOptions(undefined), []);
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
    assert.ok(!extensionSource.includes('zipProviderRows'));

    const org = schema.match(/<key name="show-org-name" type="b">([\s\S]*?)<\/key>/);
    assert.ok(org, 'schema lacks show-org-name');
    assert.match(org[1], /<default>true<\/default>/);
    assert.match(extensionSource, /get_boolean\('show-org-name'\)/);
    assert.match(extensionSource, /providerPlan\(status, showOrgName\)/);
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
    assert.match(webSource, /saveChange\(/);
    assert.match(extensionSource, /parseLayoutAtColumns\(/);
    // Workspace-keyed ids: the legacy bare `codex` entry is migrated once, and the
    // migration's own popup-layout write must not trigger a nested render.
    assert.match(extensionSource, /migrateBareProviderLayoutJson\(/);
    assert.match(extensionSource, /key === 'popup-layout' && this\._migratingLayout/);
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
    const full = {label: '7d', value: '100%', pct: 100, reset: '—'};
    assert.equal(shouldShowResetGlobal(prefs, full), true);
    assert.equal(resetTextGlobal(prefs, full), '-');
    const scheduled = {label: '5h', value: '20%', pct: 20, reset: 'in 2h'};
    assert.equal(shouldShowResetGlobal(prefs, scheduled), true);
    assert.equal(resetTextGlobal(prefs, scheduled), 'in 2h');
    assert.equal(shouldShowResetGlobal({getBoolean: () => false}, full), false);
});

test('the full rule follows the floored gauge percentage', () => {
    const on = {has: () => true, getBoolean: () => true};
    const off = {has: () => true, getBoolean: () => false};
    const at = (pct, reset) => ({label: '7d', value: `${pct}%`, pct, reset});
    // 99.95 and 99.97 draw as 99% with a not-full arc: the countdown stays
    // visible even when "show reset when full" is off.
    for (const pct of [99.95, 99.97, 99.99]) {
        assert.equal(circlePercentText(pct), '99%');
        assert.equal(shouldShowResetGlobal(off, at(pct, 'in 2h')), true, String(pct));
        assert.equal(shouldShowReset(off, at(pct, 'in 2h'), 'claude'), true, String(pct));
        assert.equal(resetTextGlobal(off, at(pct, 'in 2h')), 'in 2h', String(pct));
        assert.equal(resetText(off, at(pct, 'in 2h'), 'claude'), 'in 2h', String(pct));
        // Without a reset time a not-full metric has nothing to show.
        assert.equal(resetTextGlobal(on, at(pct, '—')), '—', String(pct));
        assert.equal(shouldShowResetGlobal(on, at(pct, '—')), false, String(pct));
    }
    // Only a gauge that reads 100% is full.
    assert.equal(circlePercentText(100), '100%');
    assert.equal(shouldShowResetGlobal(off, at(100, 'in 2h')), false);
    assert.equal(shouldShowResetGlobal(on, at(100, 'in 2h')), true);
    assert.equal(shouldShowResetGlobal(on, at(100, '—')), true);
    assert.equal(resetTextGlobal(on, at(100, '—')), '-');
    assert.equal(shouldShowResetGlobal(off, at(120, '—')), false);
    // Non-percentage metrics are never full.
    const balance = {label: 'bal', value: '$5', pct: null, reset: '—'};
    assert.equal(shouldShowResetGlobal(on, balance), false);
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

// A GSettings stand-in whose set_* emit `changed::<key>` synchronously, like a
// local write does, so the extension's own handler can re-enter itself.
function fakeSettings(values) {
    const handlers = [];
    const writes = [];
    const fake = {
        values,
        writes,
        get_strv: key => [...values[key]],
        set_strv(key, value) {
            writes.push(key);
            values[key] = [...value];
            for (const handler of handlers)
                handler(key);
        },
        get_string: key => values[key],
        set_string(key, value) {
            writes.push(key);
            values[key] = value;
            for (const handler of handlers)
                handler(key);
        },
        onChanged: handler => handlers.push(handler),
    };
    return fake;
}

test('label migrator rewrites stale hidden-metrics once and is idempotent', () => {
    const settings = fakeSettings({
        'hidden-metrics': ['claude:7d Sonnet', 'go:Weekly', 'codex:5h'],
        'metric-options': [],
        'popup-layout': '',
    });
    const migrate = createMetricLabelMigrator(settings);
    settings.onChanged(key => {
        if (key === 'hidden-metrics')
            migrate(['hidden-metrics']);
    });
    assert.equal(migrate(['hidden-metrics']), 1);
    assert.deepEqual(settings.values['hidden-metrics'], ['claude:Sonnet 7d', 'go:7d', 'codex:5h']);
    // The nested `changed` emission was ignored, and a later echo is a no-op.
    assert.deepEqual(settings.writes, ['hidden-metrics']);
    assert.equal(migrate(['hidden-metrics']), 0);
    assert.deepEqual(settings.writes, ['hidden-metrics']);
});

test('label migrator handles a stale file copy pushed after enable', () => {
    const settings = fakeSettings({'hidden-metrics': ['codex:5h'], 'metric-options': [], 'popup-layout': ''});
    const migrate = createMetricLabelMigrator(settings);
    let handled = 0;
    settings.onChanged(key => {
        if (key !== 'hidden-metrics')
            return;
        handled++;
        migrate(['hidden-metrics']);
    });
    // The settings server later writes old spellings straight into dconf.
    settings.set_strv('hidden-metrics', ['gemini:Claude/GPT 5h', 'gemini:C/C 5h']);
    assert.deepEqual(settings.values['hidden-metrics'], ['gemini:C/C 5h']);
    // push, our migrated write; the nested call from the push handler runs
    // (not yet inside a migration), the one from our write is skipped.
    assert.equal(handled, 2);
    assert.equal(settings.writes.length, 2);
});

test('label migrator migrates the layout and reports errors without throwing', () => {
    const layout = JSON.stringify({columns: 3, providers: [{id: 'claude', order: ['5h', '7d Sonnet']}]});
    const settings = fakeSettings({'hidden-metrics': [], 'metric-options': [], 'popup-layout': layout});
    assert.equal(createMetricLabelMigrator(settings)(), 1);
    assert.deepEqual(JSON.parse(settings.values['popup-layout']).providers[0].order, ['5h', 'Sonnet 7d']);
    const errors = [];
    const broken = createMetricLabelMigrator({get_strv() { throw new Error('boom'); }}, e => errors.push(e.message));
    assert.equal(broken(['hidden-metrics']), 0);
    assert.deepEqual(errors, ['boom']);
    // A failure must not leave the guard stuck.
    assert.equal(broken(['hidden-metrics']), 0);
    assert.equal(errors.length, 2);
});

test('normalizeThresholds keeps red strictly below amber', () => {
    assert.deepEqual(normalizeThresholds(30, 10), {warning: 30, critical: 10});
    assert.deepEqual(normalizeThresholds(30, 90), {warning: 90, critical: 30});
    assert.deepEqual(normalizeThresholds(30, 30), {warning: 30, critical: 29});
    assert.deepEqual(normalizeThresholds(1, 1), {warning: 1, critical: 0});
    assert.deepEqual(normalizeThresholds(undefined, 'x'), {warning: 30, critical: 10});
    assert.deepEqual(normalizeThresholds(500, -5), {warning: 99, critical: 0});
});

test('threshold readers show amber for an inverted hand-edited pair', () => {
    // warning 30, critical 90 would otherwise paint every gauge <= 90% red;
    // swapped, the amber band (30, 90] is back.
    assert.equal(thresholdState(50, 30, 90), 'warning');
    assert.equal(thresholdState(20, 30, 90), 'critical');
    assert.equal(thresholdState(95, 30, 90), 'ok');
    assert.equal(thresholdState(25, 30, 10), 'warning');
    assert.equal(thresholdState(10, 30, 10), 'critical');
    assert.equal(thresholdState(31, 30, 10), 'ok');
    const settings = {'warning-threshold': 30, 'critical-threshold': 90};
    assert.equal(gaugeTone(60, settings), 'warning');
    assert.equal(gaugeTone(60, {}), 'ok');
    assert.equal(gaugeTone(5, {}), 'critical');
});

test('constrainThresholdEdit pushes the other slider to keep red below amber', () => {
    const saved = {'warning-threshold': 30, 'critical-threshold': 10};
    assert.deepEqual(constrainThresholdEdit('warning-threshold', 5, saved),
        {'warning-threshold': 5, 'critical-threshold': 4});
    // The sibling restarts from the saved pair, so dragging back restores it.
    assert.deepEqual(constrainThresholdEdit('warning-threshold', 40, saved),
        {'warning-threshold': 40, 'critical-threshold': 10});
    assert.deepEqual(constrainThresholdEdit('critical-threshold', 60, saved),
        {'warning-threshold': 61, 'critical-threshold': 60});
    assert.deepEqual(constrainThresholdEdit('critical-threshold', 98, saved),
        {'warning-threshold': 99, 'critical-threshold': 98});
    assert.deepEqual(constrainThresholdEdit('warning-threshold', 1, saved),
        {'warning-threshold': 1, 'critical-threshold': 0});
    // Out-of-range input is clamped; an inverted saved pair is normalised first.
    assert.deepEqual(constrainThresholdEdit('warning-threshold', 200, saved),
        {'warning-threshold': 99, 'critical-threshold': 10});
    assert.deepEqual(constrainThresholdEdit('warning-threshold', 95, {'warning-threshold': 30, 'critical-threshold': 90}),
        {'warning-threshold': 95, 'critical-threshold': 30});
});

test('extension wires the hidden-metrics migration and thresholds', () => {
    assert.ok(extensionSource.includes("connect('changed::hidden-metrics'"));
    assert.ok(extensionSource.includes('this._settings.disconnect(this._hiddenMetricsSignal)'));
    assert.ok(extensionSource.includes('thresholdState('));
});

// --- mergeMetricOptions keeps gauges of providers the Layout editor removed ---

const okStatus = (key, ...labels) => ({key, state: 'ok', metrics: labels.map(label => ({label}))});
const KNOWN = ['claude', 'codex', 'copilot'];

test('mergeMetricOptions keeps remembered gauges of known providers that are not enabled', () => {
    const merged = mergeMetricOptions(['claude:5h', 'claude:7d', 'codex:5h'], [okStatus('codex', '5h')], KNOWN);
    assert.deepEqual(merged, ['codex:5h', 'claude:5h', 'claude:7d']);
});

test('mergeMetricOptions prunes providers that are no longer known', () => {
    const merged = mergeMetricOptions(['gone:5h', 'claude:5h'], [okStatus('codex', '5h')], KNOWN);
    assert.deepEqual(merged, ['codex:5h', 'claude:5h']);
});

test('mergeMetricOptions keeps every remembered provider when no known list is given', () => {
    const merged = mergeMetricOptions(['other:x', 'claude:5h'], [okStatus('codex', '5h')]);
    assert.deepEqual(merged, ['codex:5h', 'other:x', 'claude:5h']);
});

test('mergeMetricOptions replaces fresh providers, keeps failed ones, ignores empty status sets', () => {
    const current = ['claude:5h', 'claude:old', 'codex:5h'];
    assert.deepEqual(
        mergeMetricOptions(current, [okStatus('claude', '5h', '7d'), {key: 'codex', state: 'net_err', metrics: []}], KNOWN),
        ['claude:5h', 'claude:7d', 'codex:5h'],
    );
    assert.deepEqual(mergeMetricOptions(current, [], KNOWN), current);
});

// --- mergeWorkspaceOptions keeps workspaces whose fetch failed this cycle ---

const ws = (id, label = id) => JSON.stringify({id, label});

test('mergeWorkspaceOptions keeps a workspace missing from this cycle', () => {
    const merged = mergeWorkspaceOptions([ws('a', 'Plus · a'), ws('b', 'Team · b')], [{id: 'a', label: 'Plus · a'}]);
    assert.deepEqual(merged, [ws('a', 'Plus · a'), ws('b', 'Team · b')]);
});

test('mergeWorkspaceOptions updates labels in place and appends new workspaces', () => {
    const merged = mergeWorkspaceOptions(
        [ws('a', 'old'), ws('b')],
        [{id: 'c', label: 'C'}, {id: 'b', label: 'B new'}],
    );
    assert.deepEqual(merged, [ws('a', 'old'), ws('b', 'B new'), ws('c', 'C')]);
});

test('mergeWorkspaceOptions leaves the stored list alone for an empty fresh list', () => {
    const previous = [ws('a'), 'not json'];
    assert.deepEqual(mergeWorkspaceOptions(previous, []), previous);
    assert.deepEqual(mergeWorkspaceOptions(previous, null), previous);
    assert.deepEqual(mergeWorkspaceOptions(undefined, []), []);
});

test('mergeWorkspaceOptions result is identical to the stored value when nothing changed', () => {
    const previous = [ws('a', 'A'), ws('b', 'B')];
    assert.deepEqual(mergeWorkspaceOptions(previous, [{id: 'b', label: 'B'}, {id: 'a', label: 'A'}]), previous);
});

test('mergeWorkspaceOptions falls back to the id as label, drops unparsable and duplicate entries', () => {
    const merged = mergeWorkspaceOptions([ws('a'), 'garbage', ws('a', 'dup')], [{id: 'z'}, {id: ''}, null]);
    assert.deepEqual(merged, [ws('a'), ws('z')]);
});

test('mergeWorkspaceOptions caps the list, dropping the oldest unseen workspaces first', () => {
    const previous = Array.from({length: 4}, (_, index) => ws(`w${index}`));
    const merged = mergeWorkspaceOptions(previous, [{id: 'w1'}, {id: 'new'}], 4);
    assert.deepEqual(merged, [ws('w1'), ws('w2'), ws('w3'), ws('new')]);
    assert.equal(MAX_REMEMBERED_WORKSPACES, 50);
});

test('mergeWorkspaceOptions never drops a workspace seen this cycle to satisfy the cap', () => {
    const merged = mergeWorkspaceOptions([ws('old'), ws('a')], [{id: 'a'}, {id: 'b'}], 2);
    assert.deepEqual(merged, [ws('a'), ws('b')]);
});

test('flooredPercent absorbs float representation error but nothing real', () => {
    // Remaining derived as 100 - utilization can land just below the whole
    // number; the CLI prints it as 86%.
    const remaining = 85.99999999999999;
    assert.ok(remaining < 86);
    assert.equal(flooredPercent(remaining), 86);
    assert.equal(circlePercentText(remaining), '86%');
    assert.equal(displayMetricValue({label: '5h', value: '86%', pct: remaining}), '86%');
    // Representation-level error below 1e-9 counts as the whole number.
    assert.equal(flooredPercent(99.99999999999999), 100);
    assert.equal(isFullPercent(99.99999999999999), true);
    // Real fractions still floor, and 99.x is never full.
    for (const pct of [99.95, 99.97, 99.99, 99.9999]) {
        assert.equal(flooredPercent(pct), 99, String(pct));
        assert.equal(isFullPercent(pct), false, String(pct));
    }
    assert.equal(flooredPercent(85.5), 85);
    assert.equal(flooredPercent(0.4), 0);
    // Clamped to 0..100, junk reads as 0.
    assert.equal(flooredPercent(100.5), 100);
    assert.equal(flooredPercent(-3), 0);
    assert.equal(flooredPercent(NaN), 0);
    assert.equal(flooredPercent(undefined), 0);
    assert.equal(isFullPercent(null), false);
});

test('legacy Claude labels keep a trailing dedup counter at the end', () => {
    assert.equal(migrateMetricLabel('claude', '7d Sonnet'), 'Sonnet 7d');
    assert.equal(migrateMetricLabel('claude', '7d Sonnet 2'), 'Sonnet 7d 2');
    assert.equal(migrateMetricLabel('claude', '7d Sonnet 4.5'), 'Sonnet 4.5 7d');
    assert.equal(migrateMetricLabel('claude', '7d Claude Design'), 'Claude Design 7d');
    // The bare window's own dedup label is not a model name.
    assert.equal(migrateMetricLabel('claude', '7d 2'), '7d 2');
    assert.equal(migrateMetricLabel('claude', '7d'), '7d');
    // Already current labels and other providers are untouched.
    assert.equal(migrateMetricLabel('claude', 'Sonnet 7d 2'), 'Sonnet 7d 2');
    assert.equal(migrateMetricLabel('codex', '7d Sonnet 2'), '7d Sonnet 2');
});
