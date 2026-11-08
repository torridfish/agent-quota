import assert from 'node:assert/strict';
import test from 'node:test';

const {createEditHistory} = await import('../gnome-shell-extension/web-settings/edit-history.js');

// A page with the layout plus the settings a layout edit may carry.
const snap = (layout, overrides = {}) => ({
    layout,
    settings: {
        providers: ['claude', 'codex'],
        'provider-order': ['claude', 'codex'],
        'override-providers': true,
        'use-cli-config': false,
        'hidden-metrics': [],
        'codex-workspaces': [],
        ...overrides,
    },
});

test('consecutive layout edits undo and redo in order', () => {
    const history = createEditHistory();
    const s0 = snap('L0');
    const s1 = snap('L1');
    const s2 = snap('L2');
    history.record(s0, s1);
    history.record(s1, s2);
    assert.equal(history.canUndo, true);

    let step = history.undo(s2);
    assert.equal(step.status, 'ok');
    assert.deepEqual(step.snapshot, s1);
    history.settle(s1);
    step = history.undo(s1);
    assert.deepEqual(step.snapshot, s0);
    history.settle(s0);
    assert.equal(history.canUndo, false);
    assert.equal(history.undo(s0).status, 'empty');

    step = history.redo(s0);
    assert.equal(step.status, 'ok');
    assert.deepEqual(step.snapshot, s1);
    history.settle(s1);
    assert.equal(history.canRedo, true);
});

test('hide/show gauge changes hidden-metrics with the layout and stays undoable', () => {
    const history = createEditHistory();
    const before = snap('L0');
    const hidden = snap('L1', {'hidden-metrics': ['claude:7d']});
    const moved = snap('L2', {'hidden-metrics': ['claude:7d']});
    history.record(before, hidden);
    history.record(hidden, moved);
    const first = history.undo(moved);
    assert.equal(first.status, 'ok');
    history.settle(first.snapshot);
    const second = history.undo(first.snapshot);
    assert.equal(second.status, 'ok');
    assert.deepEqual(second.snapshot.settings['hidden-metrics'], []);
});

test('undo after a Providers-page change drops the history instead of re-enabling the service', () => {
    const history = createEditHistory();
    const a = snap('L0');                       // before the drag
    const afterDrag = snap('L1');               // after the drag
    history.record(a, afterDrag);
    // The Providers page switches zai... here: codex off.
    const afterProviders = snap('L1', {providers: ['claude']});
    assert.equal(history.undo(afterProviders).status, 'stale');
    assert.equal(history.canUndo, false);
    assert.equal(history.canRedo, false);
});

test('redo after a settings change elsewhere is dropped too', () => {
    const history = createEditHistory();
    const s0 = snap('L0');
    const s1 = snap('L1');
    history.record(s0, s1);
    assert.equal(history.undo(s1).status, 'ok');
    history.settle(s0);
    assert.equal(history.canRedo, true);
    assert.equal(history.redo(snap('L0', {'codex-workspaces': ['ws-a']})).status, 'stale');
    assert.equal(history.canRedo, false);
});

test('dropIfStale clears the history on page entry; a matching state keeps it', () => {
    const history = createEditHistory();
    history.record(snap('L0'), snap('L1'));
    assert.equal(history.dropIfStale(snap('L1')), false);
    assert.equal(history.canUndo, true);
    assert.equal(history.dropIfStale(snap('L1', {'provider-order': ['codex', 'claude']})), true);
    assert.equal(history.canUndo, false);
});

test('an edit made after an outside change starts a fresh history', () => {
    const history = createEditHistory();
    history.record(snap('L0'), snap('L1'));
    const outside = snap('L1', {providers: ['claude']});
    history.record(outside, snap('L2', {providers: ['claude']}));
    const step = history.undo(snap('L2', {providers: ['claude']}));
    assert.equal(step.status, 'ok');
    assert.deepEqual(step.snapshot, outside);
    history.settle(step.snapshot);
    // The pre-outside entry was dropped.
    assert.equal(history.undo(outside).status, 'empty');
});

test('reset empties both stacks and the limit bounds the history', () => {
    const history = createEditHistory(3);
    for (let i = 0; i < 5; i++)
        history.record(snap(`L${i}`), snap(`L${i + 1}`));
    let count = 0;
    let current = snap('L5');
    while (history.canUndo) {
        const step = history.undo(current);
        current = step.snapshot;
        history.settle(current);
        count++;
    }
    assert.equal(count, 3);
    history.record(snap('L0'), snap('L1'));
    history.reset();
    assert.equal(history.canUndo || history.canRedo, false);
});
