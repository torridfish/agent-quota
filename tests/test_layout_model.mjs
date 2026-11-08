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
    moveProvider,
    normalizeLayoutColumns,
    normalizeMetricOrder,
    packLayout,
    parseLayout,
    placeProvider,
    providerGridSpan,
    removeProvider,
    reorderProviders,
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

test('moveGauge, moveProvider, and reorderProviders update the model', () => {
    const layout = defaultLayout(['claude', 'codex'], metrics, {columns: 3, gaugeColumns: 2});
    const movedGauge = moveGauge(layout, 'claude', 0, 1);
    assert.deepEqual(movedGauge.providers[0].order, ['7d', '5h']);

    const movedProvider = moveProvider(layout, 'codex', 1, 2, metrics, {columns: 3});
    const codex = movedProvider.providers.find(provider => provider.id === 'codex');
    assert.deepEqual({col: codex.col, row: codex.row}, {col: 1, row: 2});

    const reordered = reorderProviders(layout, 1, 0, metrics, {columns: 3});
    assert.deepEqual(reordered.providers.map(provider => provider.id), ['codex', 'claude']);
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
    const {MAX_GRID_ROWS, MAX_LAYOUT_ROW} = await layoutModule;
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
    assert.ok(packed.providers[0].row <= MAX_GRID_ROWS);
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
