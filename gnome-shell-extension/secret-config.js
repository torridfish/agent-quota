// Parsing rules for ~/.config/agent-quota/*.conf files.
//
// The Python loaders (providers/copilot.py, providers/zai.py, ...) strip
// whitespace around keys and values and let the last assignment win.  The
// GNOME preferences must agree, or they would show one value while the
// backend uses another.

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assignmentPattern(key, suffix, flags) {
    return new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=${suffix}$`, flags);
}

export function readAssignment(contents, key) {
    // Last assignment wins, matching the backend loaders.
    let value = '';
    for (const match of contents.matchAll(assignmentPattern(key, '(.*)', 'gm')))
        value = match[1].trim();
    return value;
}

export function upsertAssignment(contents, key, value) {
    const assignment = `${key}=${value.trim()}`;
    // No 'g' flag here: a stateful regex would leak lastIndex between the
    // per-line test() calls below.
    const matcher = assignmentPattern(key, '.*', 'm');
    const lines = contents.split('\n');
    let insertAt = -1;
    const kept = [];
    for (const line of lines) {
        if (matcher.test(line)) {
            // Record where this assignment sat; a later duplicate overwrites
            // the position so only one assignment remains.
            insertAt = kept.length;
        } else {
            kept.push(line);
        }
    }
    if (insertAt === -1) {
        const text = contents.trimEnd();
        return `${text}${text ? '\n' : ''}${assignment}\n`;
    }
    kept.splice(insertAt, 0, assignment);
    return kept.join('\n');
}
