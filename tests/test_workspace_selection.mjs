import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const source = readFileSync(
    new URL('../gnome-shell-extension/workspace-selection.js', import.meta.url),
    'utf8',
);
const encoded = Buffer.from(source).toString('base64');
const {
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

    assert.deepEqual(filterCodexStatuses(statuses, ['a']), [
        statuses[0],
        statuses[2],
        statuses[3],
    ]);
});

test('empty workspace selection keeps every status', () => {
    const statuses = [{key: 'codex', state: 'ok', workspace_id: 'a'}];

    assert.strictEqual(filterCodexStatuses(statuses, []), statuses);
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
