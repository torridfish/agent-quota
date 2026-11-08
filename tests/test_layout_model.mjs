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

const layoutModule = loadModule('layout-model.js');
const {
    DEFAULT_LAYOUT_COLUMNS,
    defaultLayout,
    insertGauge,
    layoutGrid,
    layoutReadingOrder,
    layoutToJson,
    moveGauge,
    normalizeLayoutColumns,
    normalizeMetricOrder,
    packLayout,
    parseLayout,
    parseLayoutAtColumns,
    placeProvider,
    providerGridSpan,
    removeProvider,
    setProviderGaugeColumns,
} = await loadModule('layout-model.js');

const metrics = new Map([
    ['claude', ['5h', '7d']],
    ['codex', ['5h', '7d', 'Credits']],
    ['gemini', []],
]);

test('columns are clamped to the supported global grid', () => {
    assert.equal(normalizeLayoutColumns(0), 1);
    assert.equal(normalizeLayoutColumns(9), 5);
    assert.equal(normalizeLayoutColumns('2'), 2);
    assert.equal(normalizeLayoutColumns(undefined), DEFAULT_LAYOUT_COLUMNS);
});

test('metric order keeps saved labels and appends new backend metrics', () => {
    assert.deepEqual(
        normalizeMetricOrder(['7d', 'stale', '5h'], ['5h', '7d', 'Credits']),
        ['7d', '5h', 'Credits'],
    );
    assert.deepEqual(normalizeMetricOrder(['7d', '5h'], []), ['7d', '5h']);
});

test('a card wraps its gauges instead of leaving an empty requested column', () => {
    const span = providerGridSpan(
        {id: 'claude', gaugeColumns: 3, order: ['5h', '7d']},
        ['5h', '7d'],
        3,
    );
    assert.equal(span.gaugeColumns, 2);
    assert.equal(span.gaugeRows, 1);
    assert.equal(span.w, 2);
    assert.equal(span.h, 2);
});

test('a provider with no metrics is a header-only card', () => {
    const span = providerGridSpan({id: 'gemini', gaugeColumns: 3, order: []}, [], 3);
    assert.equal(span.w, 1);
    assert.equal(span.h, 1);
    assert.equal(span.gaugeRows, 0);
});

test('default layout packs cards without overlap', () => {
    const layout = defaultLayout(['claude', 'codex', 'gemini'], metrics, {
        columns: 3,
        gaugeColumns: 3,
    });
    assert.equal(layout.columns, 3);
    const byId = new Map(layout.providers.map(provider => [provider.id, provider]));
    assert.deepEqual(
        {col: byId.get('claude').col, row: byId.get('claude').row},
        {col: 0, row: 0},
    );
    // Claude is 2 columns wide; Codex needs all 3, so it starts below.
    assert.deepEqual(
        {col: byId.get('codex').col, row: byId.get('codex').row},
        {col: 0, row: 2},
    );
    assert.deepEqual(
        {col: byId.get('gemini').col, row: byId.get('gemini').row},
        {col: 2, row: 0},
    );
});

test('layoutGrid aligns gauges to the same global columns and row tracks', () => {
    const layout = defaultLayout(['claude', 'codex'], metrics, {
        columns: 3,
        gaugeColumns: 3,
    });
    const grid = layoutGrid(layout, metrics, {
        cellWidth: 50,
        columnGap: 10,
        rowGap: 8,
        headerHeight: 20,
        cellHeight: 60,
    });
    const claude = grid.providers.find(provider => provider.id === 'claude');
    const codex = grid.providers.find(provider => provider.id === 'codex');

    assert.equal(grid.width, 3 * 50 + 2 * 10);
    assert.equal(claude.width, 2 * 50 + 10);
    assert.equal(codex.width, 3 * 50 + 2 * 10);
    assert.deepEqual(claude.gauges.map(gauge => gauge.x), [0, 60]);
    assert.deepEqual(codex.gauges.map(gauge => gauge.x), [0, 60, 120]);
    // Claude starts at row 0, Codex at row 2.  Their gauge rows still use the
    // same global row heights.
    assert.deepEqual(claude.gauges.map(gauge => gauge.y), [28, 28]);
    assert.deepEqual(codex.gauges.map(gauge => gauge.y), [124, 124, 124]);
    assert.equal(claude.height, 20 + 8 + 60);
    assert.equal(codex.height, 20 + 8 + 60);
});

test('a colliding explicit position is re-packed instead of overlapping', () => {
    const layout = packLayout({
        columns: 2,
        providers: [
            {id: 'a', col: 0, row: 0, gaugeColumns: 1, order: ['x']},
            {id: 'b', col: 0, row: 0, gaugeColumns: 1, order: ['x']},
        ],
    }, new Map([['a', ['x']], ['b', ['x']]]));
    const byId = new Map(layout.providers.map(provider => [provider.id, provider]));
    assert.notDeepEqual(
        {col: byId.get('a').col, row: byId.get('a').row},
        {col: byId.get('b').col, row: byId.get('b').row},
    );
});

test('parseLayout tolerates invalid JSON and appends missing providers', () => {
    const fallback = parseLayout('{not json', ['claude', 'codex'], metrics, {columns: 2});
    assert.equal(fallback.providers.length, 2);

    const parsed = parseLayout(JSON.stringify({
        version: 1,
        columns: 2,
        providers: [{id: 'claude', gaugeColumns: 1, order: ['7d']}],
    }), ['claude', 'codex', 'gemini'], metrics, {columns: 2});
    assert.deepEqual(parsed.providers.map(provider => provider.id), ['claude', 'codex', 'gemini']);
    assert.deepEqual(parsed.providers[0].order, ['7d', '5h']);
});

test('moveGauge updates the gauge order', () => {
    const layout = defaultLayout(['claude', 'codex'], metrics, {columns: 3, gaugeColumns: 2});
    const movedGauge = moveGauge(layout, 'claude', 0, 1);
    assert.deepEqual(movedGauge.providers[0].order, ['7d', '5h']);
});

test('setProviderGaugeColumns and layoutToJson round-trip', () => {
    const layout = defaultLayout(['claude'], metrics, {columns: 3, gaugeColumns: 3});
    const changed = setProviderGaugeColumns(layout, 'claude', 1, 3);
    assert.equal(changed.providers[0].gaugeColumns, 1);
    const parsed = JSON.parse(layoutToJson(changed));
    assert.equal(parsed.providers[0].gaugeColumns, 1);
});

test('packLayout removes empty rows left by a shrinking card', () => {
    const layout = packLayout({
        columns: 3,
        providers: [
            {id: 'a', col: 0, row: 0, gaugeColumns: 3, order: ['x']},
            {id: 'b', col: 0, row: 5, gaugeColumns: 3, order: ['x']},
        ],
    }, new Map([['a', ['x']], ['b', ['x']]]));
    const byId = new Map(layout.providers.map(provider => [provider.id, provider]));
    // a is header + one gauge row (rows 0-1); b is moved up to row 2.
    assert.equal(byId.get('b').row, 2);
});

test('layoutGrid applies one card padding to the header and every gauge cell', () => {
    const layout = {
        columns: 2,
        providers: [{id: 'a', col: 0, row: 0, gaugeColumns: 2, order: ['x', 'y']}],
    };
    const grid = layoutGrid(layout, new Map([['a', ['x', 'y']]]), {
        cellWidth: 80,
        columnGap: 10,
        rowGap: 8,
        headerHeight: 40,
        cellHeight: 60,
        padding: 10,
    });
    const card = grid.providers[0];
    assert.equal(card.header.x, 10);
    assert.equal(card.header.y, 10);
    assert.equal(card.header.width, card.width - 20);
    assert.equal(card.header.height, 20);
    assert.deepEqual(card.gauges.map(gauge => gauge.x), [10, 100]);
    assert.deepEqual(card.gauges.map(gauge => gauge.width), [60, 60]);
    assert.deepEqual(card.gauges.map(gauge => gauge.y), [58, 58]);
    assert.deepEqual(card.gauges.map(gauge => gauge.height), [40, 40]);
});

test('layoutGrid insets the card background without moving the content tracks', () => {
    const layout = {
        columns: 2,
        providers: [{id: 'a', col: 0, row: 0, gaugeColumns: 2, order: ['x', 'y']}],
    };
    const grid = layoutGrid(layout, new Map([['a', ['x', 'y']]]), {
        cellWidth: 80,
        columnGap: 10,
        rowGap: 8,
        headerHeight: 40,
        cellHeight: 60,
        padding: 10,
        cardGap: 6,
    });
    const card = grid.providers[0];
    assert.equal(card.card.x, 3);
    assert.equal(card.card.width, card.width - 6);
    assert.equal(card.header.x, 13);
    assert.equal(card.gauges[0].x, 13);
    assert.equal(card.gauges[1].x, 103);
});

test('a provider detected with every gauge hidden becomes a header-only card', () => {
    const layout = parseLayout(
        JSON.stringify({
            version: 1,
            columns: 3,
            providers: [{id: 'claude', gaugeColumns: 3, order: ['5h', '7d']}],
        }),
        ['claude'],
        new Map([['claude', []]]),
        {columns: 3, gaugeColumns: 3},
    );
    assert.deepEqual(layout.providers[0].order, []);
    assert.equal(layout.providers[0].w, 1);
    assert.equal(layout.providers[0].h, 1);
});

test('placeProvider, removeProvider, insertGauge, and layoutReadingOrder support drag-and-drop', () => {
    let layout = defaultLayout(['claude', 'codex'], metrics, {columns: 4, gaugeColumns: 2});
    // Dropping codex at (0, 0) wins the collision and pushes claude right.
    layout = placeProvider(layout, 'codex', 0, 0, metrics, {columns: 4});
    const byId = new Map(layout.providers.map(provider => [provider.id, provider]));
    assert.deepEqual({col: byId.get('codex').col, row: byId.get('codex').row}, {col: 0, row: 0});
    assert.deepEqual({col: byId.get('claude').col, row: byId.get('claude').row}, {col: 2, row: 0});
    assert.deepEqual(layoutReadingOrder(layout), ['codex', 'claude']);

    // Dropping a new provider from the tray inserts it at the target cell.
    layout = placeProvider(layout, 'gemini', 0, 0, metrics, {columns: 4, gaugeColumns: 3});
    assert.equal(layout.providers[0].id, 'gemini');
    assert.equal(layout.providers[0].col, 0);
    assert.equal(layout.providers[0].row, 0);

    // Removing a provider drops it from the layout.
    layout = removeProvider(layout, 'codex');
    assert.deepEqual(layout.providers.map(provider => provider.id), ['gemini', 'claude']);

    // Inserting a hidden gauge back into a single-row card restores it at the requested index.
    const restored = insertGauge(layout, 'claude', 'Opus', 1);
    const claude = restored.providers.find(provider => provider.id === 'claude');
    assert.deepEqual(claude.order, ['5h', 'Opus', '7d']);
    assert.equal(claude.gaugeColumns, 3);
});

test('packLayout clamps hand-edited coordinates instead of allocating huge grids', async () => {
    const {MAX_LAYOUT_ROW} = await layoutModule;
    const started = Date.now();
    const metrics = new Map([['a', ['x', 'y']], ['b', ['x']]]);
    const raw = JSON.stringify({
        version: 1,
        columns: 3,
        providers: [
            {id: 'a', gaugeColumns: 2, order: ['x', 'y'], col: 0, row: 2000000000},
            {id: 'b', gaugeColumns: 1, order: ['x'], col: 2000000000, row: 0},
        ],
    });
    const parsed = parseLayout(raw, ['a', 'b'], metrics, {columns: 3});
    assert.ok(Date.now() - started < 1000);
    for (const provider of parsed.providers) {
        assert.ok(provider.row >= 0 && provider.row <= MAX_LAYOUT_ROW);
        assert.ok(provider.col >= 0 && provider.col < 3);
    }
    const [a, b] = parsed.providers;
    assert.ok(a.col + a.w <= 3 && b.col + b.w <= 3);

    // packLayout itself (callers other than parseLayout) must not trust coordinates either.
    const packed = packLayout({
        columns: 3,
        providers: [{id: 'a', order: ['x', 'y'], col: -5, row: Number.MAX_SAFE_INTEGER}],
    }, metrics, {columns: 3});
    assert.ok(packed.providers[0].row <= MAX_LAYOUT_ROW);
    assert.equal(packed.providers[0].col, 0);
});

test('assignLayoutIds gives each Codex workspace status a unique, workspace-keyed id', async () => {
    const {assignLayoutIds} = await layoutModule;
    const statuses = [
        {key: 'claude'},
        {key: 'codex', workspace_id: 'ws-1'},
        {key: 'codex', workspace_id: 'ws-2'},
        {key: 'codex', state: 'error'},
        {key: 'codex', workspace_id: 'ws-2'},
    ];
    const ids = assignLayoutIds(statuses);
    assert.equal(new Set(ids).size, ids.length);
    // Workspace statuses never take the bare key; the one without a workspace does.
    assert.deepEqual(ids, ['claude', 'codex:ws-1', 'codex:ws-2', 'codex', 'codex:ws-2#2']);

    const metrics = new Map([
        ['claude', ['5h']],
        ['codex:ws-1', ['5h', '7d']],
        ['codex:ws-2', ['5h', '7d']],
    ]);
    const layout = parseLayout('', ids.slice(0, 3), metrics, {columns: 3});
    assert.deepEqual(layout.providers.map(provider => provider.id), ['claude', 'codex:ws-1', 'codex:ws-2']);

    // A saved entry follows its workspace.
    const saved = JSON.stringify({
        version: 1,
        columns: 3,
        providers: [{id: 'codex:ws-2', gaugeColumns: 2, order: ['7d', '5h']}],
    });
    const parsed = parseLayout(saved, ids.slice(0, 3), metrics, {columns: 3});
    assert.deepEqual(parsed.providers.find(provider => provider.id === 'codex:ws-2').order, ['7d', '5h']);
    assert.deepEqual(parsed.providers.find(provider => provider.id === 'codex:ws-1').order, ['5h', '7d']);
});

test('codexLayoutId is pure and always fits the suffix grammar', async () => {
    const {codexLayoutId, sanitizeLayoutSuffix, LAYOUT_ID_SUFFIX_PATTERN} = await layoutModule;
    assert.equal(codexLayoutId('ws-1'), 'codex:ws-1');
    assert.equal(codexLayoutId('ws/1 é?'), 'codex:ws_1___');
    assert.equal(codexLayoutId('w'.repeat(200)), `codex:${'w'.repeat(64)}`);
    assert.equal(codexLayoutId(''), 'codex:ws');
    assert.equal(sanitizeLayoutSuffix(undefined), 'ws');
    for (const raw of ['', '中文', 'a'.repeat(100), 'x y', 42])
        assert.match(codexLayoutId(raw).slice('codex:'.length), LAYOUT_ID_SUFFIX_PATTERN);
});

test('assignLayoutIds keeps a workspace id stable regardless of order or presence', async () => {
    const {assignLayoutIds, codexLayoutId} = await layoutModule;
    const A = {key: 'codex', workspace_id: 'ws-A'};
    const B = {key: 'codex', workspace_id: 'ws-B'};
    assert.deepEqual(assignLayoutIds([A, B]), [codexLayoutId('ws-A'), codexLayoutId('ws-B')]);
    assert.deepEqual(assignLayoutIds([B, A]), [codexLayoutId('ws-B'), codexLayoutId('ws-A')]);
    // A failed or deselected workspace does not shift the survivor onto its id.
    assert.deepEqual(assignLayoutIds([B]), [codexLayoutId('ws-B')]);
    assert.deepEqual(assignLayoutIds([A]), [codexLayoutId('ws-A')]);
    // A failed placeholder without a workspace id never takes a workspace's id.
    assert.deepEqual(assignLayoutIds([{key: 'codex', state: 'error'}, B]), ['codex', codexLayoutId('ws-B')]);
    assert.deepEqual(assignLayoutIds([B, {key: 'codex', state: 'error'}]), [codexLayoutId('ws-B'), 'codex']);
    // Two statuses without a workspace id: bare key, then the index form.
    assert.deepEqual(
        assignLayoutIds([{key: 'codex'}, {key: 'claude'}, {key: 'codex'}]),
        ['codex', 'claude', 'codex:#2']);
});

test('assignLayoutIds sanitises workspace ids to the shared suffix grammar', async () => {
    const {assignLayoutIds, LAYOUT_ID_SUFFIX_PATTERN} = await layoutModule;
    const suffixOf = id => id.slice(id.indexOf(':') + 1);
    const weird = 'ws/1 é中?x%';
    const long = 'w'.repeat(200);
    const statuses = [
        {key: 'codex'},
        {key: 'codex', workspace_id: weird},
        {key: 'codex', workspace_id: long},
        {key: 'codex', workspace_id: 'a b'},
        {key: 'codex', workspace_id: 'a/b'}, // sanitises to the same suffix as 'a b'
        {key: 'codex', workspace_id: 'a?b'},
        {key: 'codex', workspace_id: long + 'different tail'},
    ];
    const ids = assignLayoutIds(statuses);
    assert.equal(ids[0], 'codex');
    for (const id of ids.slice(1))
        assert.match(suffixOf(id), LAYOUT_ID_SUFFIX_PATTERN, id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids[1], 'codex:ws_1____x_');
    assert.equal(ids[2], `codex:${'w'.repeat(64)}`);
    // Collisions after sanitising get the numeric counter (in raw-id order),
    // still within 64 chars.
    assert.equal(ids[3], 'codex:a_b'); // 'a b' < 'a/b' < 'a?b'
    assert.equal(ids[4], 'codex:a_b#2');
    assert.equal(ids[5], 'codex:a_b#3');
    assert.equal(ids[6], `codex:${'w'.repeat(62)}#2`);
    // Deterministic for the same input.
    assert.deepEqual(assignLayoutIds(statuses), ids);
});

test('assignLayoutIds collision counters do not depend on fetch order', async () => {
    const {assignLayoutIds} = await layoutModule;
    const raws = ['a?b', 'a b', 'a/b', 'a_b#2'];
    const idsByRaw = order => {
        const ids = assignLayoutIds(order.map(workspace_id => ({key: 'codex', workspace_id})));
        return Object.fromEntries(order.map((raw, index) => [raw, ids[index]]));
    };
    const expected = idsByRaw(raws);
    for (const order of [
        [...raws].reverse(),
        ['a/b', 'a_b#2', 'a?b', 'a b'],
        ['a_b#2', 'a b', 'a?b', 'a/b'],
    ])
        assert.deepEqual(idsByRaw(order), expected);
    assert.equal(expected['a b'], 'codex:a_b');
    assert.equal(expected['a/b'], 'codex:a_b#3');
    assert.equal(expected['a?b'], 'codex:a_b#4');
    // A literal workspace id that looks like a counter keeps its own plain id.
    assert.equal(expected['a_b#2'], 'codex:a_b#2');
    assert.equal(new Set(Object.values(expected)).size, raws.length);
});

test('migrateBareProviderEntry renames the bare entry to the first remembered workspace once', async () => {
    const {migrateBareProviderEntry, codexLayoutId} = await layoutModule;
    const bare = {id: 'codex', col: 1, row: 2, gaugeColumns: 2, order: ['7d', '5h']};
    const layout = {version: 1, columns: 3, providers: [{id: 'claude', col: 0, row: 0}, bare]};

    const migrated = migrateBareProviderEntry(layout, 'codex', ['ws-B', 'ws-A']);
    assert.notEqual(migrated, layout);
    assert.deepEqual(migrated.providers.map(entry => entry.id), ['claude', codexLayoutId('ws-B')]);
    assert.deepEqual(migrated.providers[1], {...bare, id: 'codex:ws-B'});
    // The input is not mutated.
    assert.equal(layout.providers[1].id, 'codex');
    assert.equal(migrated.columns, 3);

    // Idempotent: a second run (no bare entry any more) changes nothing.
    assert.equal(migrateBareProviderEntry(migrated, 'codex', ['ws-B', 'ws-A']), migrated);
});

test('migrateBareProviderEntry only looks at the first remembered workspace', async () => {
    const {migrateBareProviderEntry} = await layoutModule;
    // Other remembered workspaces having entries does not block the rename.
    const others = {providers: [{id: 'codex', order: ['5h']}, {id: 'codex:ws-B', order: ['7d']}]};
    const renamed = migrateBareProviderEntry(others, 'codex', ['ws-A', 'ws-B']);
    assert.deepEqual(renamed.providers.map(entry => entry.id), ['codex:ws-A', 'codex:ws-B']);
    // Unusable leading ids are skipped; the first usable one wins.
    const skipped = migrateBareProviderEntry({providers: [{id: 'codex'}]}, 'codex', ['', null, 'ws-C', 'ws-D']);
    assert.deepEqual(skipped.providers.map(entry => entry.id), ['codex:ws-C']);

    // The first workspace already owns an entry: never create a duplicate id.
    const taken = {providers: [{id: 'codex', order: ['5h']}, {id: 'codex:ws-A', order: ['7d']}]};
    assert.equal(migrateBareProviderEntry(taken, 'codex', ['ws-A', 'ws-B']), taken);
});

test('migrateBareProviderEntry leaves layouts it should not touch alone', async () => {
    const {migrateBareProviderEntry} = await layoutModule;
    const noBare = {providers: [{id: 'claude'}, {id: 'codex:ws-A'}]};
    assert.equal(migrateBareProviderEntry(noBare, 'codex', ['ws-A']), noBare);

    // Nothing remembered yet: keep the bare entry until the first success.
    const bareOnly = {providers: [{id: 'codex'}]};
    assert.equal(migrateBareProviderEntry(bareOnly, 'codex', []), bareOnly);
    assert.equal(migrateBareProviderEntry(bareOnly, 'codex', undefined), bareOnly);
    assert.equal(migrateBareProviderEntry(bareOnly, 'codex', ['']), bareOnly);

    // Malformed layouts pass through.
    assert.equal(migrateBareProviderEntry(null, 'codex', ['ws-A']), null);
    const noList = {providers: 'x'};
    assert.equal(migrateBareProviderEntry(noList, 'codex', ['ws-A']), noList);

    // Other providers' entries are untouched.
    const other = {providers: [{id: 'claude'}, {id: 'codex'}]};
    const migrated = migrateBareProviderEntry(other, 'codex', ['ws-A']);
    assert.deepEqual(migrated.providers.map(entry => entry.id), ['claude', 'codex:ws-A']);
});

test('migrateBareProviderLayoutJson migrates the saved JSON once and ignores bad input', async () => {
    const {migrateBareProviderLayoutJson, assignLayoutIds, LAYOUT_ID_SUFFIX_PATTERN} = await layoutModule;
    const raw = JSON.stringify({
        version: 1,
        columns: 3,
        providers: [{id: 'claude'}, {id: 'codex', order: ['5h'], col: 2, row: 0}],
    });
    const remembered = ['ws/1', 'ws-2'];
    const migrated = migrateBareProviderLayoutJson(raw, 'codex', remembered);
    assert.notEqual(migrated, raw);
    const providers = JSON.parse(migrated).providers;
    assert.deepEqual(providers.map(entry => entry.id), ['claude', 'codex:ws_1']);
    assert.match(providers[1].id.slice('codex:'.length), LAYOUT_ID_SUFFIX_PATTERN);
    assert.deepEqual(providers[1].order, ['5h']);
    // The migrated entry is what the popup now looks up for that workspace.
    assert.equal(assignLayoutIds([{key: 'codex', workspace_id: 'ws/1'}])[0], 'codex:ws_1');
    // Idempotent, and a no-op without remembered workspaces or valid JSON.
    assert.equal(migrateBareProviderLayoutJson(migrated, 'codex', remembered), migrated);
    assert.equal(migrateBareProviderLayoutJson(raw, 'codex', []), raw);
    assert.equal(migrateBareProviderLayoutJson('{nope', 'codex', remembered), '{nope');
    assert.equal(migrateBareProviderLayoutJson('', 'codex', remembered), '');
});

test('expandFailedWorkspaceStatuses keeps every remembered workspace card through a failed fetch', async () => {
    const {expandFailedWorkspaceStatuses, assignLayoutIds, parseLayout, codexLayoutId} = await layoutModule;
    const remembered = [{id: 'ws-A', label: 'Team · a'}, {id: 'ws-B', label: 'Pro · b'}, {id: 'ws-C', label: ''}];
    const okB = {key: 'codex', state: 'ok', workspace_id: 'ws-B', metrics: [{label: '5h'}]};
    const failed = {key: 'codex', name: 'Codex', state: 'net_err', error: 'boom', metrics: []};
    const claude = {key: 'claude', state: 'ok'};

    // Total failure: all remembered workspaces become placeholders, in stored order.
    const total = expandFailedWorkspaceStatuses([claude, failed], 'codex', remembered);
    assert.deepEqual(total.map(status => status.workspace_id ?? status.key), ['claude', 'ws-A', 'ws-B', 'ws-C']);
    assert.deepEqual(assignLayoutIds(total), ['claude', 'codex:ws-A', 'codex:ws-B', 'codex:ws-C']);
    assert.ok(total.slice(1).every(status => status.placeholder && status.state === 'net_err' && status.error === 'boom'));
    // The remembered label names the card; no label keeps the original name.
    assert.equal(total[1].plan, 'Team · a');
    assert.equal(total[3].plan, undefined);
    assert.equal(total[3].name, 'Codex');
    assert.equal(failed.workspace_id, undefined);

    // Partial failure: only the workspaces that did not respond are placeholders,
    // and the healthy workspace keeps the very id it would have anyway.
    const partial = expandFailedWorkspaceStatuses([okB, failed], 'codex', remembered);
    assert.deepEqual(partial.map(status => status.workspace_id), ['ws-B', 'ws-A', 'ws-C']);
    assert.equal(partial[0], okB);
    assert.deepEqual(assignLayoutIds(partial), ['codex:ws-B', 'codex:ws-A', 'codex:ws-C']);

    // The selection restricts the placeholders; an empty selection means all.
    const selected = expandFailedWorkspaceStatuses([failed], 'codex', remembered, ['ws-C', 'ws-A']);
    assert.deepEqual(selected.map(status => status.workspace_id), ['ws-A', 'ws-C']);
    assert.equal(expandFailedWorkspaceStatuses([failed], 'codex', remembered, []).length, 3);

    // One saved entry per workspace survives parseLayout, at its saved position.
    const saved = JSON.stringify({version: 1, columns: 3, providers: [
        {id: 'codex:ws-B', col: 2, row: 0, order: ['5h']},
        {id: 'codex:ws-A', col: 0, row: 0, order: ['5h']},
    ]});
    const ids = assignLayoutIds(total);
    const orders = new Map(ids.map(id => [id, ['5h']]));
    const layout = parseLayout(saved, ids, orders, {columns: 3});
    const at = id => layout.providers.find(entry => entry.id === id);
    assert.deepEqual([at(codexLayoutId('ws-A')).col, at(codexLayoutId('ws-B')).col], [0, 2]);
    assert.ok(!layout.providers.some(entry => entry.id === 'codex'));
});

test('expandFailedWorkspaceStatuses falls back to the bare card when it cannot expand', async () => {
    const {expandFailedWorkspaceStatuses} = await layoutModule;
    const failed = {key: 'codex', state: 'net_err', error: 'boom', metrics: []};
    const okA = {key: 'codex', state: 'ok', workspace_id: 'ws-A'};

    // No remembered workspace: today's bare-key placeholder.
    const none = [failed];
    assert.equal(expandFailedWorkspaceStatuses(none, 'codex', [], []), none);
    assert.equal(expandFailedWorkspaceStatuses(none, 'codex', undefined), none);
    // Everything remembered already responded (or is deselected): unchanged.
    const covered = [okA, failed];
    assert.equal(expandFailedWorkspaceStatuses(covered, 'codex', [{id: 'ws-A'}], []), covered);
    assert.equal(expandFailedWorkspaceStatuses(covered, 'codex', [{id: 'ws-A'}, {id: 'ws-B'}], ['ws-A']), covered);
    // No id-less status of that key: unchanged, and other providers are never touched.
    const healthy = [okA, {key: 'claude', state: 'net_err'}];
    assert.equal(expandFailedWorkspaceStatuses(healthy, 'codex', [{id: 'ws-B'}]), healthy);
    // Malformed remembered entries are skipped, duplicates collapse.
    const odd = expandFailedWorkspaceStatuses([failed], 'codex', [null, {id: ''}, {id: 'ws-A'}, {id: 'ws-A'}]);
    assert.deepEqual(odd.map(status => status.workspace_id), ['ws-A']);
});

test('settings preview and popup share one cell-height formula', async () => {
    const {widgetCellHeight} = await import('../gnome-shell-extension/meter-layout.js');
    const {gridOptions, popupGeometry} = await import(
        '../gnome-shell-extension/web-settings/gauge-preview.js');
    const samples = [
        {},
        {'circle-radius': 22, 'layout-padding': 6, 'circle-metric-spacing': 4,
            'gauge-percent-offset': 35, 'gauge-label-font-size': 11,
            'gauge-reset-font-size': 10, 'gauge-percent-font-size': 0},
        {'circle-radius': 10, 'gauge-percent-offset': 80, 'gauge-percent-font-size': 14},
        {'circle-radius': 40, 'layout-padding': 0, 'gauge-label-font-size': 13,
            'gauge-reset-font-size': 12},
    ];
    for (const settings of samples) {
        const padding = Number(settings['layout-padding']) || 0;
        const expected = widgetCellHeight({
            radius: settings['circle-radius'],
            spacing: settings['circle-metric-spacing'],
            percentFontSize: settings['gauge-percent-font-size'],
            percentOffsetPct: settings['gauge-percent-offset'],
            labelFontSize: settings['gauge-label-font-size'],
            resetFontSize: settings['gauge-reset-font-size'],
            hasReset: true,
        }) + 2 * padding;
        assert.equal(popupGeometry(settings).cellHeight, expected);
        assert.equal(gridOptions(settings).cellHeight, expected);
    }
    // The reset row is only reserved when a gauge shows a reset.
    const withReset = widgetCellHeight({radius: 16, resetFontSize: 10, hasReset: true});
    const without = widgetCellHeight({radius: 16, resetFontSize: 10, hasReset: false});
    assert.equal(withReset - without, Math.ceil(withReset - without));
    assert.ok(withReset > without);
    // Lower-arc height, not the full ring diameter.
    assert.ok(without < 2 * 16 + 20);
});

test('the popup ring container always reserves the number height', async () => {
    const {circleGaugeLayout, popupGaugeShape, widgetCellHeight} = await import(
        '../gnome-shell-extension/meter-layout.js');
    const {popupGeometry} = await import('../gnome-shell-extension/web-settings/gauge-preview.js');
    for (const [radius, font, offset] of [[16, 0, 0], [22, 0, 35], [10, 14, 80], [40, 0, 0], [16, 0, -60]]) {
        const layout = circleGaugeLayout(radius, font, offset);
        const shape = popupGaugeShape(radius, font, offset);
        // _circleMeter takes its geometry from here for every cell, so the
        // height is the same with a visible number, a hidden one or a failed
        // placeholder, and it is the height the row was sized for.
        assert.equal(layout.height, shape.rowGaugeHeight);
        assert.ok(layout.height >= Math.ceil(shape.textBottom));
        assert.ok(layout.height >= Math.ceil(shape.arcBottom));
        assert.equal(layout.width, shape.radius * 2);
        assert.equal(layout.centerY, shape.centerY);
        const cell = widgetCellHeight({
            radius, percentFontSize: font, percentOffsetPct: offset,
            labelFontSize: 11, resetFontSize: 10, hasReset: false,
        });
        assert.equal(cell, Math.ceil(layout.height + 11 * 1.3 + 4));
        // The settings preview draws the same container, hidden number or not.
        for (const mode of ['percent', 'hidden']) {
            const geometry = popupGeometry({
                'circle-radius': radius, 'gauge-percent-font-size': font,
                'gauge-percent-offset': offset, 'gauge-percent': mode,
            });
            assert.equal(geometry.ringHeight, layout.height);
        }
    }
});

test('a tall single-column layout round-trips through pack, serialise and parse', async () => {
    const {MAX_LAYOUT_ROW} = await layoutModule;
    const ids = Array.from({length: 70}, (_unused, index) => `codex:ws-${index}`);
    const metrics = new Map(ids.map(id => [id, ['5h', '7d']]));
    const packed = defaultLayout(ids, metrics, {columns: 1, gaugeColumns: 1});

    // One column, header plus two gauge rows per card: far past the old cap of 100.
    const lastRow = Math.max(...packed.providers.map(provider => provider.row));
    assert.ok(lastRow > 100 && lastRow <= MAX_LAYOUT_ROW, `last row ${lastRow}`);

    const parsed = parseLayout(layoutToJson(packed), ids, metrics, {columns: 1});
    assert.deepEqual(
        parsed.providers.map(({id, col, row}) => ({id, col, row})),
        packed.providers.map(({id, col, row}) => ({id, col, row})),
    );
});

test('saved rows are clamped at MAX_LAYOUT_ROW', async () => {
    const {MAX_LAYOUT_ROW} = await layoutModule;
    assert.equal(MAX_LAYOUT_ROW, 1000);
    const metrics = new Map([['a', ['x']]]);
    const parsed = parseLayout(JSON.stringify({
        version: 1,
        columns: 1,
        providers: [{id: 'a', gaugeColumns: 1, order: ['x'], col: 0, row: MAX_LAYOUT_ROW + 500}],
    }), ['a'], metrics, {columns: 1});
    // The requested row is clamped to the ceiling, which the grid cannot
    // hold, so the card packs to the first free slot instead of overflowing.
    assert.equal(parsed.providers[0].row, 0);
    // A row inside the ceiling is accepted as saved (then compacted), not rejected.
    const kept = parseLayout(JSON.stringify({
        version: 1,
        columns: 1,
        providers: [{id: 'a', gaugeColumns: 1, order: ['x'], col: 0, row: 500}],
    }), ['a'], metrics, {columns: 1});
    assert.ok(kept.providers[0].row <= MAX_LAYOUT_ROW);
});

function assertInBounds(layout, MAX_LAYOUT_ROW) {
    for (const card of layout.providers) {
        assert.ok(Number.isInteger(card.row) && card.row >= 0, `row ${card.row}`);
        assert.ok(card.row + card.h <= MAX_LAYOUT_ROW, `${card.id} ends past the grid`);
        assert.ok(card.col >= 0 && card.col + card.w <= layout.columns);
    }
}

test('packing more single-row cards than the grid holds never throws and stays in bounds', async () => {
    const {MAX_LAYOUT_ROW} = await layoutModule;
    for (const columns of [1, 3]) {
        const count = MAX_LAYOUT_ROW * columns + 150;
        const providers = Array.from({length: count}, (_, i) => ({id: `p${i}`, gaugeColumns: 1}));
        const run = () => packLayout({columns, providers}, new Map(), {columns});
        const packed = run();
        assert.equal(packed.providers.length, count);
        assertInBounds(packed, MAX_LAYOUT_ROW);
        assert.deepEqual(run(), packed);
        // Cards that fit keep their first-free-slot order; the overflow is
        // clamped to the last grid row instead of leaving the grid.
        assert.equal(packed.providers[0].row, 0);
        assert.equal(packed.providers[count - 1].row, MAX_LAYOUT_ROW - 1);
        assert.equal(packed.providers[count - 1].col, 0);
        const grid = layoutGrid(packed, new Map(), {cellWidth: 10, headerHeight: 5, cellHeight: 5});
        assert.equal(grid.providers.length, count);
    }
});

test('a card taller than the old allocation slack packs without throwing', async () => {
    const {MAX_LAYOUT_ROW} = await layoutModule;
    // Fill the whole grid with 1-wide cards, then add a card with h > 64.
    const labels = Array.from({length: 80}, (_, i) => `m${i}`);
    const providers = Array.from({length: MAX_LAYOUT_ROW}, (_, i) => ({id: `p${i}`, gaugeColumns: 1}));
    providers.push({id: 'tall', gaugeColumns: 1, order: labels});
    const metrics = new Map([['tall', labels]]);
    const packed = packLayout({columns: 1, providers}, metrics, {columns: 1});
    const tall = packed.providers.at(-1);
    assert.equal(tall.h, 81);
    assert.equal(tall.row, MAX_LAYOUT_ROW - 81);
    assertInBounds(packed, MAX_LAYOUT_ROW);
    assert.deepEqual(packLayout({columns: 1, providers}, metrics, {columns: 1}), packed);
    assert.ok(layoutGrid(packed, metrics, {cellWidth: 10, headerHeight: 5, cellHeight: 5}).rows <= MAX_LAYOUT_ROW);
});

test('a card with more gauges than the grid has rows is trimmed to the grid', async () => {
    const {MAX_LAYOUT_ROW} = await layoutModule;
    const labels = Array.from({length: MAX_LAYOUT_ROW + 200}, (_, i) => `m${i}`);
    const metrics = new Map([['huge', labels]]);
    const layout = {columns: 1, providers: [{id: 'huge', gaugeColumns: 1, order: labels}]};
    const packed = packLayout(layout, metrics, {columns: 1});
    const [card] = packed.providers;
    assert.equal(card.row, 0);
    assert.equal(card.h, MAX_LAYOUT_ROW);
    assert.equal(card.order.length, MAX_LAYOUT_ROW - 1);
    assert.deepEqual(card.order, labels.slice(0, MAX_LAYOUT_ROW - 1));
    assert.deepEqual(packLayout(layout, metrics, {columns: 1}), packed);
    const grid = layoutGrid(packed, metrics, {cellWidth: 10, headerHeight: 5, cellHeight: 5});
    assert.equal(grid.rows, MAX_LAYOUT_ROW);
});

test('a hand-edited layout with huge row values packs in bounds', async () => {
    const {MAX_LAYOUT_ROW} = await layoutModule;
    const metrics = new Map([['a', ['x', 'y']], ['b', ['x']], ['c', []]]);
    const raw = JSON.stringify({
        version: 1,
        columns: 3,
        providers: [
            {id: 'a', gaugeColumns: 2, order: ['x', 'y'], col: 0, row: 1e12},
            {id: 'b', gaugeColumns: 1, order: ['x'], col: 2, row: MAX_LAYOUT_ROW - 1},
            {id: 'c', gaugeColumns: 1, order: [], col: 1, row: Number.MAX_SAFE_INTEGER},
        ],
    });
    const parsed = parseLayout(raw, ['a', 'b', 'c'], metrics, {columns: 3});
    assertInBounds(parsed, MAX_LAYOUT_ROW);
    assert.deepEqual(parseLayout(raw, ['a', 'b', 'c'], metrics, {columns: 3}), parsed);
    // Packing the unpacked, huge-row entries directly is also total.
    const direct = packLayout(JSON.parse(raw), metrics);
    assertInBounds(direct, MAX_LAYOUT_ROW);
    // Rows past the grid fall back to the first free slot, in provider order.
    assert.deepEqual(direct.providers.map(card => card.row), [0, 0, 2]);
    // Non-integer and negative rows are ignored rather than trusted.
    const odd = packLayout({columns: 3, providers: [
        {id: 'a', order: ['x'], col: 0, row: -5},
        {id: 'b', order: ['x'], col: 0, row: 1.5},
    ]}, metrics);
    assertInBounds(odd, MAX_LAYOUT_ROW);
});

test('layoutGrid gives identical results for packed input and a JSON round trip', () => {
    const options = {
        cellWidth: 100, columnGap: 6, rowGap: 4, headerHeight: 20, cellHeight: 60,
        padding: 3, cardGap: 5,
    };
    const providerIds = ['claude', 'codex', 'gemini', 'extra'];
    const raw = JSON.stringify({
        version: 1,
        columns: 3,
        providers: [
            {id: 'claude', gaugeColumns: 2, order: ['7d', '5h'], col: 1, row: 0},
            {id: 'codex', gaugeColumns: 3, order: ['5h', '7d', 'Credits']},
            {id: 'gemini', gaugeColumns: 2, order: []},
        ],
    });
    const packed = parseLayout(raw, providerIds, metrics, {columns: 3});
    const unpacked = JSON.parse(JSON.stringify(packed));
    assert.deepEqual(layoutGrid(packed, metrics, options), layoutGrid(unpacked, metrics, options));
    // Packing again is idempotent, so the input is never altered or re-resolved.
    const before = JSON.stringify(packed);
    layoutGrid(packed, metrics, options);
    assert.equal(JSON.stringify(packed), before);
    assert.deepEqual(packLayout(packed, metrics, {columns: 3}), packed);
    // An edited layout is laid out from its edited entries.
    const edited = parseLayout(raw, providerIds, metrics, {columns: 3});
    edited.providers[0].gaugeColumns = 1;
    assert.deepEqual(
        layoutGrid(edited, metrics, options),
        layoutGrid(JSON.parse(JSON.stringify(edited)), metrics, options),
    );
    assert.equal(layoutGrid(edited, metrics, options).providers[0].gaugeRows, 2);
    // So is a different metrics map.
    const other = new Map([['claude', ['5h']], ['codex', []], ['gemini', ['a']], ['extra', []]]);
    assert.deepEqual(
        layoutGrid(packed, other, options),
        layoutGrid(JSON.parse(JSON.stringify(packed)), other, options),
    );
});

test('parseLayoutAtColumns makes the caller column count win over the saved one', () => {
    const ids = ['a', 'b', 'c'];
    const available = new Map(ids.map(id => [id, ['x']]));
    const raw = JSON.stringify({version: 1, columns: 3, providers: [
        {id: 'a', gaugeColumns: 1, order: ['x'], col: 0, row: 0},
        {id: 'b', gaugeColumns: 1, order: ['x'], col: 1, row: 0},
        {id: 'c', gaugeColumns: 1, order: ['x'], col: 2, row: 0},
    ]});
    // parseLayout keeps preferring the saved count; the setting is ignored.
    assert.equal(parseLayout(raw, ids, available, {columns: 4}).columns, 3);

    // Setting 4 vs saved 3: the layout is 4 wide and saved cells stay put.
    const wider = parseLayoutAtColumns(raw, ids, available, {columns: 4, gaugeColumns: 4});
    assert.equal(wider.columns, 4);
    assert.deepEqual(wider.providers.map(({id, col, row}) => ({id, col, row})), [
        {id: 'a', col: 0, row: 0},
        {id: 'b', col: 1, row: 0},
        {id: 'c', col: 2, row: 0},
    ]);
    // A new card fills the extra column instead of wrapping to a new row.
    const grown = parseLayoutAtColumns(raw, [...ids, 'd'], new Map([...available, ['d', ['x']]]), {columns: 4});
    assert.deepEqual(grown.providers.find(p => p.id === 'd'), {
        id: 'd', gaugeColumns: 1, order: ['x'], col: 3, row: 0, w: 1, h: 2,
    });

    // Setting smaller than the saved count: cards are repacked within it.
    const narrower = parseLayoutAtColumns(raw, ids, available, {columns: 2});
    assert.equal(narrower.columns, 2);
    for (const card of narrower.providers)
        assert.ok(card.col + card.w <= 2, card.id);
    assert.deepEqual(narrower.providers.map(({id, col, row}) => ({id, col, row})), [
        {id: 'a', col: 0, row: 0},
        {id: 'b', col: 1, row: 0},
        {id: 'c', col: 0, row: 2},
    ]);

    // Wide cards are clamped to the setting too.
    const wideRaw = JSON.stringify({columns: 4, providers: [
        {id: 'a', gaugeColumns: 4, order: ['x', 'y', 'z', 'w'], col: 0, row: 0},
    ]});
    const wide = parseLayoutAtColumns(wideRaw, ['a'], new Map([['a', ['x', 'y', 'z', 'w']]]), {columns: 2});
    assert.equal(wide.providers[0].w, 2);
    assert.equal(wide.providers[0].gaugeColumns, 2);

    // Unusable input still falls back to the default layout at the setting.
    for (const bad of ['', 'not json', '{"providers": 3}']) {
        const fallback = parseLayoutAtColumns(bad, ids, available, {columns: 4});
        assert.equal(fallback.columns, 4);
        assert.equal(fallback.providers.length, 3);
    }
});
