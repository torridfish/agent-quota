// Undo/redo history of the Layout editor, without any DOM or store access.
//
// A snapshot is `{layout, settings}`: the layout plus the settings a layout
// edit can change together with it (provider selection and order, hidden
// gauges, Codex workspaces).  Restoring one writes all of those keys back.
// That is only safe while nothing else touched them: the Providers page can
// switch a service off between two Layout edits, and undoing the earlier edit
// would silently switch it on again.
//
// The rule: the history remembers the settings it expects the page to hold
// (what the last editor action left behind).  When the settings differ from
// that at the next undo/redo or render, they changed elsewhere (the Providers
// page, a failed-save rollback, a reload), so the history is dropped instead
// of reverting those changes.  Consecutive editor actions, including hide/show
// gauge, always leave the expected settings in place, so undo keeps working.

const DEFAULT_LIMIT = 60;

function fingerprint(snapshot) {
    return JSON.stringify(snapshot?.settings ?? null);
}

export function createEditHistory(limit = DEFAULT_LIMIT) {
    let undoStack = [];
    let redoStack = [];
    // Fingerprint of the settings after the last editor action; null while the
    // history is empty (nothing to protect).
    let expected = null;

    const isStale = current => expected !== null && fingerprint(current) !== expected;

    const reset = () => {
        undoStack = [];
        redoStack = [];
        expected = null;
    };

    // Drop the history when the settings changed outside the editor.  Returns
    // whether it did.
    const dropIfStale = current => {
        if (!isStale(current))
            return false;
        reset();
        return true;
    };

    const step = (from, to, current) => {
        if (!from.length)
            return {status: 'empty'};
        if (isStale(current)) {
            reset();
            return {status: 'stale'};
        }
        to.push(current);
        if (to.length > limit)
            to.shift();
        return {status: 'ok', snapshot: from.pop()};
    };

    return {
        get canUndo() {
            return undoStack.length > 0;
        },
        get canRedo() {
            return redoStack.length > 0;
        },
        /** An editor action turned `before` into `after`. */
        record(before, after) {
            if (isStale(before))
                reset();
            undoStack.push(before);
            if (undoStack.length > limit)
                undoStack.shift();
            redoStack = [];
            expected = fingerprint(after);
        },
        /** The snapshot to restore, or {status: 'empty' | 'stale'} (history dropped when stale). */
        undo: current => step(undoStack, redoStack, current),
        redo: current => step(redoStack, undoStack, current),
        /** An undo/redo restored a snapshot and left the page in `after`. */
        settle(after) {
            expected = fingerprint(after);
        },
        dropIfStale,
        reset,
    };
}
