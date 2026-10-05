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
