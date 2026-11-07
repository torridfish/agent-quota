import assert from 'node:assert/strict';
import test from 'node:test';

// store.js reads window/document at call time and api.js reads the token at
// import time, so stub the browser globals before importing it.
globalThis.window = {
    location: {search: '?token=t'},
    setTimeout: () => 0,
    clearTimeout: () => {},
};
globalThis.document = {getElementById: () => null};

const store = await import('../gnome-shell-extension/web-settings/store.js');
const {parseLayout} = await import('../gnome-shell-extension/layout-model.js');
const {state, hydrate, saveSetting, saveChange, subscribe} = store;

// A scripted settings server: records the order requests start and finish,
// how many ran at once, and can delay or reject chosen requests.
function installServer({delay = () => 0, fail = () => false, serverState = null} = {}) {
    const log = {started: [], finished: [], maxActive: 0, active: 0, stateReads: 0};
    globalThis.fetch = async (path, {method = 'GET', body = null} = {}) => {
        const payload = body ? JSON.parse(body) : null;
        if (path === '/api/state') {
            log.stateReads += 1;
            return {ok: true, json: async () => structuredClone(serverState)};
        }
        const entry = {path, payload};
        log.started.push(entry);
        log.active += 1;
        log.maxActive = Math.max(log.maxActive, log.active);
        await new Promise(resolve => setTimeout(resolve, delay(entry)));
        log.active -= 1;
        log.finished.push(entry);
        if (fail(entry))
            return {ok: false, status: 400, json: async () => ({error: 'rejected'})};
        return {ok: true, json: async () => ({key: payload?.key, value: payload?.value, ok: true})};
    };
    return log;
}

function baseData(extra = {}) {
    return {
        providers: [{id: 'claude'}, {id: 'codex'}, {id: 'zai'}],
        secrets: {},
        cliEnabled: null,
        settings: {
            providers: ['claude', 'codex'],
            'override-providers': true,
            'use-cli-config': false,
            'provider-order': ['claude', 'codex', 'zai'],
            'layout-columns': 3,
            'popup-layout': '',
            'hidden-metrics': [],
            'metric-options': [],
            'circle-radius': 20,
            'show-user-info': true,
            ...extra,
        },
    };
}

test('saveSetting rolls back to the confirmed value even after the control pre-mutated', async () => {
    installServer({fail: () => true});
    hydrate(baseData());
    let rollbacks = 0;
    const off = subscribe('rollback', () => { rollbacks += 1; });
    // A slider writes state during drag, then calls saveSetting on release.
    state.settings['circle-radius'] = 30;
    await assert.rejects(saveSetting('circle-radius', 30), /rejected/);
    assert.equal(state.settings['circle-radius'], 20);
    assert.equal(rollbacks, 1);
    off();
});

test('a failed save does not undo a newer edit of the same key', async () => {
    const log = installServer({
        delay: entry => entry.payload.value === 25 ? 20 : 0,
        fail: entry => entry.payload.value === 25,
    });
    hydrate(baseData());
    const first = saveSetting('circle-radius', 25).catch(() => 'failed');
    const second = saveSetting('circle-radius', 28);
    assert.equal(await first, 'failed');
    assert.equal(await second, 28);
    assert.equal(state.settings['circle-radius'], 28);
    assert.equal(log.maxActive, 1);
});

test('saves run one at a time in call order', async () => {
    const log = installServer({delay: entry => entry.payload.key === 'a' ? 30 : 0});
    hydrate(baseData());
    const jobs = [
        saveSetting('a', 1),
        saveChange({settings: {b: 2}}),
        saveSetting('c', 3),
    ];
    await Promise.all(jobs);
    assert.equal(log.maxActive, 1);
    assert.deepEqual(log.finished.map(entry => entry.payload.key), ['a', 'b', 'c']);
});

test('saveChange reloads server state only after the queue drains', async () => {
    const serverState = baseData({'show-user-info': true});
    const log = installServer({
        fail: entry => entry.payload.key === 'bad',
        serverState,
    });
    hydrate(baseData());
    const failing = saveChange({settings: {bad: 1}});
    const later = saveSetting('show-user-info', false);
    assert.equal(await failing, false);
    // The later edit is still in flight, so no reload may have started yet.
    assert.equal(log.stateReads, 0);
    await later;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(log.stateReads, 1);
    assert.equal(state.settings['show-user-info'], true);
    assert.equal(state.settings.bad, undefined);
});

test('a reload that finishes after a newer edit is discarded', async () => {
    const log = installServer({
        fail: entry => entry.payload.key === 'bad',
        serverState: baseData(),
    });
    hydrate(baseData());
    await saveChange({settings: {bad: 1}});
    // The reload is now in flight; a new optimistic edit must survive it.
    const edit = saveSetting('circle-radius', 31);
    await edit;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(log.stateReads >= 1);
    assert.equal(state.settings['circle-radius'], 31);
});

test('persisted layout keeps entries of disabled providers', async () => {
    const saved = JSON.stringify({
        version: 1,
        columns: 3,
        providers: [
            {id: 'claude', gaugeColumns: 2, order: ['7d', '5h'], col: 0, row: 0},
            {id: 'codex', gaugeColumns: 1, order: ['5h'], col: 1, row: 0},
        ],
    });
    const log = installServer();
    hydrate(baseData({'popup-layout': saved}));

    // Toggle Claude off, then edit the layout on the Layout page.
    await saveChange({settings: {providers: ['codex']}});
    assert.deepEqual(state.layout.providers.map(p => p.id), ['codex']);
    await saveChange({settings: {}, layout: state.layout});

    const sent = log.finished.filter(entry => entry.path === '/api/layout').at(-1);
    const claude = sent.payload.layout.providers.find(p => p.id === 'claude');
    assert.ok(claude, 'disabled provider is still persisted');
    assert.equal(claude.gaugeColumns, 2);
    assert.deepEqual(claude.order, ['7d', '5h']);
    assert.equal(state.settings['popup-layout'], JSON.stringify(sent.payload.layout));

    // Re-enabling restores the arrangement instead of the default.
    const view = parseLayout(state.settings['popup-layout'], ['claude', 'codex'], new Map(), {});
    assert.equal(view.providers.find(p => p.id === 'claude').gaugeColumns, 2);
    assert.deepEqual(view.providers.find(p => p.id === 'claude').order, ['7d', '5h']);
});

test('mergeDisabledProviders drops unknown providers and bad data', () => {
    const view = {version: 1, columns: 3, providers: [{id: 'codex', gaugeColumns: 3, order: []}]};
    const raw = JSON.stringify({providers: [
        {id: 'ghost', gaugeColumns: 2, order: []},
        {id: 'claude', gaugeColumns: 99, order: ['5h', 7], col: -1, row: 2},
        {id: 'codex', gaugeColumns: 1, order: []},
    ]});
    const merged = store.mergeDisabledProviders(view, raw, ['claude', 'codex']);
    assert.deepEqual(merged.providers.map(p => p.id), ['codex', 'claude']);
    const claude = merged.providers[1];
    assert.deepEqual(claude.order, ['5h']);
    assert.equal(claude.col, undefined);
    assert.equal(claude.row, 2);
    assert.ok(claude.gaugeColumns >= 1 && claude.gaugeColumns <= 5);
    assert.equal(store.mergeDisabledProviders(view, 'not json', ['codex']), view);
});

test('mergeDisabledProviders keeps per-workspace card entries and drops bad ones', () => {
    const view = {version: 1, columns: 3, providers: [{id: 'codex', gaugeColumns: 3, order: []}]};
    const raw = JSON.stringify({providers: [
        {id: 'codex', gaugeColumns: 1, order: []},
        {id: 'codex:ws-1', gaugeColumns: 2, order: ['5h', 7], col: 1, row: 3},
        {id: 'codex:#2', gaugeColumns: 99, order: []},
        {id: 'codex:ws-1', gaugeColumns: 4, order: []},
        {id: 'ghost:ws-1', gaugeColumns: 1, order: []},
        {id: 'codex:', gaugeColumns: 1, order: []},
        {id: 'codex:has space', gaugeColumns: 1, order: []},
        {id: `codex:${'x'.repeat(65)}`, gaugeColumns: 1, order: []},
    ]});
    const merged = store.mergeDisabledProviders(view, raw, ['codex']);
    assert.deepEqual(merged.providers.map(p => p.id), ['codex', 'codex:ws-1', 'codex:#2']);
    const ws = merged.providers[1];
    assert.equal(ws.gaugeColumns, 2);
    assert.deepEqual(ws.order, ['5h']);
    assert.equal(ws.col, 1);
    assert.equal(ws.row, 3);
    assert.ok(merged.providers[2].gaugeColumns <= 5);
});

test('saving the layout preserves per-workspace card entries', async () => {
    const saved = JSON.stringify({
        version: 1, columns: 3,
        providers: [
            {id: 'codex', gaugeColumns: 1, order: ['5h'], col: 0, row: 0},
            {id: 'codex:ws-1', gaugeColumns: 2, order: ['7d', '5h'], col: 2, row: 1},
        ],
    });
    const log = installServer();
    hydrate(baseData({'popup-layout': saved}));
    await saveChange({settings: {}, layout: state.layout});

    const sent = log.finished.filter(entry => entry.path === '/api/layout').at(-1);
    const extra = sent.payload.layout.providers.find(p => p.id === 'codex:ws-1');
    assert.ok(extra, 'workspace card entry is still persisted');
    assert.equal(extra.gaugeColumns, 2);
    assert.deepEqual(extra.order, ['7d', '5h']);
    assert.equal(extra.col, 2);
    assert.equal(extra.row, 1);
    assert.equal(state.settings['popup-layout'], JSON.stringify(sent.payload.layout));
});
