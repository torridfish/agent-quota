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
const {state, hydrate, saveSetting, saveChange, subscribe, enabledProviderIds} = store;
const {previewSetting, previewedSettings, clearPreview, hasPreview} = store;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A scripted settings server: records the order requests start and finish,
// how many ran at once, and can delay or reject chosen requests.
function installServer({
    delay = () => 0, fail = () => false, serverState = null, stateDelay = 0, stateFail = () => false,
} = {}) {
    const log = {started: [], finished: [], maxActive: 0, active: 0, stateReads: 0};
    globalThis.fetch = async (path, {method = 'GET', body = null} = {}) => {
        const payload = body ? JSON.parse(body) : null;
        if (path === '/api/state') {
            log.stateReads += 1;
            // The server answers with the state as of the request.
            const snapshot = structuredClone(serverState);
            await new Promise(resolve => setTimeout(resolve, stateDelay));
            if (stateFail(log.stateReads))
                return {ok: false, status: 500, json: async () => ({error: 'down'})};
            return {ok: true, json: async () => snapshot};
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
    const serverState = baseData();
    const log = installServer({
        fail: entry => entry.payload.key === 'bad',
        serverState,
        stateDelay: 20,
    });
    hydrate(baseData());
    await saveChange({settings: {bad: 1}});
    // The reload is now in flight; a new optimistic edit must survive it.
    const edit = saveSetting('circle-radius', 31);
    await edit;
    await sleep(10);
    assert.ok(log.stateReads >= 1);
    // The in-flight (pre-edit) answer was dropped, not applied.
    assert.equal(state.settings['circle-radius'], 31);
    serverState.settings['circle-radius'] = 31;
    await sleep(80);
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

test('a failed layout save rolls back unsaved values immediately', async () => {
    installServer({
        fail: entry => entry.path === '/api/layout',
        serverState: baseData(),
        stateDelay: 30,
    });
    hydrate(baseData());
    const before = {
        layout: state.settings['popup-layout'],
        columns: state.settings['layout-columns'],
        order: state.settings['provider-order'],
    };
    const next = {...state.layout, columns: 2};
    assert.equal(await saveChange({
        settings: {'provider-order': ['zai', 'codex', 'claude']},
        layout: next,
    }), false);
    // The server re-read is still in flight: the rollback alone fixed the page.
    assert.equal(state.settings['popup-layout'], before.layout);
    assert.equal(state.settings['layout-columns'], before.columns);
    assert.deepEqual(state.settings['provider-order'], before.order);
    await sleep(60);
});

test('a discarded reload is retried once the queue is idle again', async () => {
    const serverState = baseData({'show-user-info': false});
    const log = installServer({
        fail: entry => entry.path === '/api/layout',
        serverState,
        stateDelay: 20,
    });
    hydrate(baseData());
    assert.equal(await saveChange({settings: {}, layout: state.layout}), false);
    // The reload is in flight; the user edits again and that edit succeeds
    // before the (now stale) re-read returns, so the re-read is discarded.
    await saveSetting('circle-radius', 31);
    serverState.settings['circle-radius'] = 31;
    await sleep(120);
    assert.equal(log.stateReads, 2, 'discarded re-read is retried');
    assert.equal(state.settings['show-user-info'], false, 'server state was hydrated');
    assert.equal(state.settings['circle-radius'], 31);
});

test('a reload that cannot reach the server is retried after the next write', async () => {
    const log = installServer({
        fail: entry => entry.path === '/api/layout',
        serverState: baseData({'show-user-info': false}),
        stateFail: reads => reads === 1,
    });
    hydrate(baseData());
    assert.equal(await saveChange({settings: {}, layout: state.layout}), false);
    await sleep(20);
    assert.equal(log.stateReads, 1);
    assert.equal(state.settings['show-user-info'], true);
    await saveSetting('circle-radius', 22);
    await sleep(20);
    assert.equal(log.stateReads, 2);
    assert.equal(state.settings['show-user-info'], false);
});

test('a layout change is one /api/layout request carrying every supported setting', async () => {
    const log = installServer();
    hydrate(baseData({'override-providers': false}));
    const next = {...state.layout, columns: 2};
    const ok = await saveChange({
        settings: {
            'provider-order': ['zai', 'claude', 'codex'],
            'layout-columns': 2,
            'override-providers': true,
            providers: ['zai', 'claude'],
            'hidden-metrics': ['claude:5h'],
        },
        layout: next,
    });
    assert.equal(ok, true);
    const layoutCalls = log.finished.filter(entry => entry.path === '/api/layout');
    assert.equal(layoutCalls.length, 1);
    assert.deepEqual(layoutCalls[0].payload.settings, {
        'provider-order': ['zai', 'claude', 'codex'],
        'override-providers': true,
        providers: ['zai', 'claude'],
        'layout-columns': state.layout.columns,
    });
    // Only what the layout endpoint does not accept goes through /api/settings.
    const settingCalls = log.finished.filter(entry => entry.path === '/api/settings');
    assert.deepEqual(settingCalls.map(entry => entry.payload.key), ['hidden-metrics']);
    assert.deepEqual(log.finished.map(entry => entry.path), ['/api/settings', '/api/layout']);
    assert.equal(state.settings['layout-columns'], state.layout.columns);
});

test('enabledProviderIds falls back to every provider when config.toml has none usable', () => {
    const follow = {'override-providers': false, 'use-cli-config': true};
    const all = ['claude', 'codex', 'zai'];
    for (const cliEnabled of [[], ['ghost'], null]) {
        const data = baseData(follow);
        data.cliEnabled = cliEnabled;
        assert.deepEqual(enabledProviderIds(data), all, JSON.stringify(cliEnabled));
    }
    const partial = baseData(follow);
    partial.cliEnabled = ['zai', 'ghost'];
    assert.deepEqual(enabledProviderIds(partial), ['zai']);
    // With an override the user's own (possibly empty) selection stands.
    const manual = baseData({providers: []});
    manual.cliEnabled = [];
    assert.deepEqual(enabledProviderIds(manual), []);
});

test('a preview never touches state.settings and an abandoned one leaves no trace', async () => {
    const log = installServer();
    hydrate(baseData());
    previewSetting('circle-radius', 31);
    assert.equal(state.settings['circle-radius'], 20);
    assert.equal(previewedSettings()['circle-radius'], 31);
    assert.equal(previewedSettings()['show-user-info'], true);
    // Pointercancel / re-render: the preview is dropped, nothing was saved.
    clearPreview('circle-radius');
    assert.equal(hasPreview('circle-radius'), false);
    assert.equal(previewedSettings(), state.settings);
    assert.equal(state.settings['circle-radius'], 20);
    assert.equal(log.started.length, 0);
    // Saving the original value afterwards is a plain save: the server value
    // is what rollback restores, not the abandoned drag.
    await saveSetting('circle-radius', 22);
    assert.equal(state.settings['circle-radius'], 22);
});

test('an abandoned preview does not change the next changed comparison', async () => {
    installServer();
    hydrate(baseData());
    previewSetting('circle-radius', 31);
    clearPreview('circle-radius');
    // saveChange only sends keys that differ from state.settings; with the
    // preview kept out of it, writing the unchanged value is a no-op ...
    const log = installServer();
    assert.equal(await saveChange({settings: {'circle-radius': 20}}), true);
    assert.equal(log.started.length, 0);
    // ... and the abandoned value (31) is a real change that is sent.
    assert.equal(await saveChange({settings: {'circle-radius': 31}}), true);
    assert.deepEqual(log.started.map(entry => entry.payload.value), [31]);
});

test('saving, hydrating or a failed save clears the preview of that key', async () => {
    installServer();
    hydrate(baseData());
    previewSetting('circle-radius', 31);
    previewSetting('show-user-info', false);
    await saveSetting('circle-radius', 31);
    assert.equal(hasPreview('circle-radius'), false);
    assert.equal(hasPreview('show-user-info'), true);
    hydrate(baseData());
    assert.equal(hasPreview('show-user-info'), false);

    installServer({fail: () => true});
    previewSetting('circle-radius', 28);
    await assert.rejects(saveSetting('circle-radius', 28), /rejected/);
    assert.equal(hasPreview('circle-radius'), false);
    assert.equal(state.settings['circle-radius'], 20);
    assert.equal(previewedSettings()['circle-radius'], 20);

    installServer();
    hydrate(baseData());
    previewSetting('layout-gap', 9);
    await saveChange({settings: {'layout-gap': 9}});
    assert.equal(hasPreview('layout-gap'), false);
});
