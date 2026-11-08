import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const source = readFileSync(
    new URL('../gnome-shell-extension/workspace-selection.js', import.meta.url),
    'utf8',
);
const encoded = Buffer.from(source).toString('base64');
const {
    effectiveWorkspaceIds,
    filterCodexStatuses,
    selectionAfterWorkspaceToggle,
} = await import(`data:text/javascript;base64,${encoded}`);

test('workspace filtering retains Codex errors and other providers', () => {
    const statuses = [
        {key: 'codex', state: 'ok', workspace_id: 'a'},
        {key: 'codex', state: 'ok', workspace_id: 'b'},
        {key: 'codex', state: 'auth_err', workspace_id: ''},
        {key: 'claude', state: 'ok', workspace_id: ''},
    ];

    assert.deepEqual(filterCodexStatuses(statuses, ['a', 'b'], ['a']), [
        statuses[0],
        statuses[2],
        statuses[3],
    ]);
});

test('empty workspace selection keeps every status', () => {
    const statuses = [{key: 'codex', state: 'ok', workspace_id: 'a'}];

    assert.strictEqual(filterCodexStatuses(statuses, ['a'], []), statuses);
});

test('workspace toggles preserve temporarily unavailable selections', () => {
    assert.deepEqual(
        selectionAfterWorkspaceToggle(['a', 'b'], ['a', 'stale'], 'b', true),
        ['a', 'b', 'stale'],
    );
});

test('selecting every known workspace normalizes to show all', () => {
    assert.deepEqual(
        selectionAfterWorkspaceToggle(['a', 'b'], ['a'], 'b', true),
        [],
    );
});

test('the final visible workspace cannot be deselected', () => {
    assert.equal(
        selectionAfterWorkspaceToggle(['a', 'b'], ['a', 'stale'], 'a', false),
        null,
    );
});

test('stale-only workspace selection shows every available workspace', () => {
    const statuses = [
        {key: 'codex', state: 'ok', workspace_id: 'a'},
        {key: 'codex', state: 'ok', workspace_id: 'b'},
        {key: 'codex', state: 'auth_err', workspace_id: ''},
        {key: 'claude', state: 'ok', workspace_id: ''},
    ];

    assert.deepEqual(filterCodexStatuses(statuses, ['a', 'b'], ['gone', 'stale']), statuses);
});

test('a partly stale workspace selection shows only the valid ids', () => {
    const statuses = [
        {key: 'codex', state: 'ok', workspace_id: 'a'},
        {key: 'codex', state: 'ok', workspace_id: 'b'},
        {key: 'claude', state: 'ok', workspace_id: ''},
    ];

    assert.deepEqual(filterCodexStatuses(statuses, ['a', 'b'], ['b', 'gone']), [
        statuses[1],
        statuses[2],
    ]);
});

test('a selected workspace that failed this cycle stays selected and hides the others', () => {
    const ok = id => ({key: 'codex', state: 'ok', workspace_id: id});
    const statuses = [
        {key: 'codex', state: 'auth_err', workspace_id: ''},
        ok('B'),
        ok('C'),
    ];

    // Remembered A, B, C; only A is selected and its fetch failed: the
    // selection still resolves to A, so B and C stay hidden and only the
    // failed status (the placeholder for A) is left.
    assert.deepEqual(filterCodexStatuses(statuses, ['A', 'B', 'C'], ['A']), [statuses[0]]);
    // The shared rule says the same thing the popup uses for its placeholders.
    assert.deepEqual(effectiveWorkspaceIds(['A', 'B', 'C'], ['A']), ['A']);
});

test('a selection absent from every remembered id falls back to all remembered workspaces', () => {
    const ok = id => ({key: 'codex', state: 'ok', workspace_id: id});
    const statuses = [
        {key: 'codex', state: 'auth_err', workspace_id: ''},
        ok('B'),
        ok('C'),
    ];

    assert.deepEqual(filterCodexStatuses(statuses, ['A', 'B', 'C'], ['gone']), statuses);
});

test('with nothing remembered yet the OK statuses stand in for the remembered ids', () => {
    const statuses = [
        {key: 'codex', state: 'ok', workspace_id: 'a'},
        {key: 'codex', state: 'ok', workspace_id: 'b'},
    ];

    assert.deepEqual(filterCodexStatuses(statuses, [], ['b']), [statuses[1]]);
    assert.deepEqual(filterCodexStatuses(statuses, [], ['gone']), statuses);
});

test('failed Codex statuses are always kept by the filter', () => {
    const statuses = [
        {key: 'codex', state: 'ok', workspace_id: 'a'},
        {key: 'codex', state: 'auth_err', workspace_id: 'b'},
    ];

    assert.deepEqual(filterCodexStatuses(statuses, ['a', 'b'], ['a']), statuses);
});

test('the toggle baseline is the displayed selection, also for stale-only ids', () => {
    // codex-workspaces=['old'] with remembered a, b displays both on.
    assert.deepEqual(effectiveWorkspaceIds(['a', 'b'], ['old']), ['a', 'b']);
    // Turning b off from that display leaves a selected, not "nothing visible".
    assert.deepEqual(selectionAfterWorkspaceToggle(['a', 'b'], ['old'], 'b', false), ['a']);
    assert.deepEqual(selectionAfterWorkspaceToggle(['a', 'b'], ['old'], 'a', false), ['b']);
    // Turning an already-displayed workspace on normalises to "show all".
    assert.deepEqual(selectionAfterWorkspaceToggle(['a', 'b'], ['old'], 'b', true), []);
    // A partly stale selection still keeps its unavailable id.
    assert.deepEqual(
        selectionAfterWorkspaceToggle(['a', 'b', 'c'], ['a', 'old'], 'b', true),
        ['a', 'b', 'old'],
    );
});

test('effectiveWorkspaceIds is the one rule for empty, partial and stale selections', () => {
    assert.deepEqual(effectiveWorkspaceIds(['a', 'b'], []), ['a', 'b']);
    assert.deepEqual(effectiveWorkspaceIds(['a', 'b'], ['b', 'gone']), ['b']);
    assert.deepEqual(effectiveWorkspaceIds(['a', 'b'], ['gone']), ['a', 'b']);
    assert.deepEqual(effectiveWorkspaceIds([], ['gone']), []);
    assert.deepEqual(effectiveWorkspaceIds(['a', 'a', 'b'], ['gone']), ['a', 'b']);
});
