// Reset-time display rules, shared between the popup renderer and tests.
//
// The prefs bridge answers `has(key)` for schema membership: a provider the
// schema does not know about (for example a backend-added provider before
// the extension schema catches up) must never reach get_boolean, which
// throws on unknown keys and would break the whole popup.

import {isFullPercent} from './meter-layout.js';

// "Full" follows the gauge: a metric is full only when its floored percentage
// is 100, so 99.97% (drawn as 99%) still shows its reset countdown.
function isFull(metric) {
    return isFullPercent(metric.pct);
}

// A missing key reads as false, which is also the schema default.
function readFlag(prefs, key) {
    return prefs.has(key) ? prefs.getBoolean(key) : false;
}

function showResetWhenFull(prefs, provider) {
    return readFlag(prefs, `show-reset-when-full-${provider}`);
}

function showResetWhenFullGlobal(prefs) {
    return readFlag(prefs, 'show-reset-when-full-global');
}

export function shouldShowReset(prefs, metric, provider) {
    if (isFull(metric))
        return showResetWhenFull(prefs, provider);
    return metric.reset !== '—';
}

export function resetText(prefs, metric, provider) {
    if (metric.reset !== '—')
        return metric.reset;
    if (isFull(metric) && showResetWhenFull(prefs, provider))
        return 'No reset scheduled';
    return '—';
}

// Widget layout uses one global reset rule instead of per-provider switches.
export function shouldShowResetGlobal(prefs, metric) {
    if (isFull(metric))
        return showResetWhenFullGlobal(prefs);
    return metric.reset !== '—';
}

export function resetTextGlobal(prefs, metric) {
    const text = String(metric.reset ?? '').trim();
    if (text && text !== '—') {
        // Some providers write a sentence such as "No reset planned" here;
        // a single dash is enough in the compact widget layout.
        if (/^no reset\b/i.test(text))
            return '-';
        return metric.reset;
    }
    if (isFull(metric) && showResetWhenFullGlobal(prefs))
        return '-';
    return '—';
}
