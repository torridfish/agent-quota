// Reset-time display rules, shared between the popup renderer and tests.
//
// The prefs bridge answers `has(key)` for schema membership: a provider the
// schema does not know about (for example a backend-added provider before
// the extension schema catches up) must never reach get_boolean, which
// throws on unknown keys and would break the whole popup.

function showResetWhenFull(prefs, provider) {
    const key = `show-reset-when-full-${provider}`;
    return prefs.has(key) ? prefs.getBoolean(key) : false;
}

export function shouldShowReset(prefs, metric, provider) {
    if (metric.pct !== null && metric.pct !== undefined && metric.pct >= 99.95)
        return showResetWhenFull(prefs, provider);
    return metric.reset !== '—';
}

export function resetText(prefs, metric, provider) {
    if (metric.reset !== '—')
        return metric.reset;
    if (metric.pct !== null && metric.pct !== undefined &&
        metric.pct >= 99.95 && showResetWhenFull(prefs, provider))
        return 'No reset scheduled';
    return '—';
}
