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

const {resetText, shouldShowReset} = await loadModule('reset-display.js');
const {providerHeader} = await loadModule('provider-header.js');

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

test('user information on keeps the original plan and user header', () => {
    assert.equal(providerHeader(accountStatus, true), 'Max 5x · person@example.com');
    // The default argument preserves the header for callers that omit it.
    assert.equal(providerHeader(accountStatus), 'Max 5x · person@example.com');
});

test('user information off leaves only the plan', () => {
    assert.equal(providerHeader(accountStatus, false), 'Max 5x');
    assert.equal(providerHeader({plan: 'Pro', user: 'a@b.c', source: 'account'}, false), 'Pro');
});

test('user information off never leaks the source fallback', () => {
    const colab = {plan: 'Google AI Plans', user: '', source: 'colab-cli oauth'};
    assert.equal(providerHeader(colab, true), 'Google AI Plans');
    assert.equal(providerHeader(colab, false), 'Google AI Plans');
    const anonymous = {...colab, plan: ''};
    assert.equal(providerHeader(anonymous, true), 'colab-cli oauth');
    assert.equal(providerHeader(anonymous, false), '');
});

test('user information off tolerates missing fields without separators', () => {
    assert.equal(providerHeader({}, false), '');
    assert.equal(providerHeader({plan: null, user: null, source: null}, false), '');
    assert.equal(providerHeader({plan: '', user: 'person@example.com', source: 'account'}, false), '');
    assert.equal(providerHeader({plan: null, user: null, source: null}, true), '');
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
    providerHeader(status, true);
    providerHeader(status, false);
    assert.equal(JSON.stringify(status), snapshot);
});

// --- F1: provider lists stay consistent with the schema ---

const extensionDir = new URL('../gnome-shell-extension/', import.meta.url);
const extensionSource = readFileSync(new URL('extension.js', extensionDir), 'utf8');
const prefsSource = readFileSync(new URL('prefs.js', extensionDir), 'utf8');
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
const prefsIds = providerIds(prefsSource);
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

test('preferences expose Show user information under Appearance → Popup', () => {
    assert.match(
        prefsSource,
        /const popup = new Adw\.PreferencesGroup\(\{title: 'Popup'\}\);/,
    );
    assert.match(
        prefsSource,
        /addSwitch\(popup, settings, 'show-user-info', 'Show user information'/,
    );
});

test('extension renders headers through provider-header.js and the setting', () => {
    assert.match(extensionSource, /import \{providerHeader\} from '\.\/provider-header\.js';/);
    assert.match(extensionSource, /get_boolean\('show-user-info'\)/);
    assert.match(extensionSource, /providerHeader\(status, showUserInfo\)/);
    assert.ok(!/function displayUser\(/.test(extensionSource), 'displayUser must live in provider-header.js');
    // The generic `changed` fallback rerenders from the cached payload; the
    // switch must not trigger a provider refetch.
    assert.ok(!extensionSource.includes("key === 'show-user-info'"));
});

test('extension seeds initial popup item and enforces subprocess timeout', () => {
    assert.ok(extensionSource.includes('Loading quotas…'));
    assert.ok(extensionSource.includes('SUBPROCESS_TIMEOUT_SECONDS'));
    assert.ok(extensionSource.includes('Promise.allSettled('));
    assert.ok(!extensionSource.includes('Promise.all('));
});
