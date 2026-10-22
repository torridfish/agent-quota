// Provider popup header, shared between the popup renderer and tests.
//
// `showUserInfo` is presentation-only. With it on, the header keeps the
// historical "plan · user" text and falls back to the status source when the
// account exposes neither. With it off, only the plan survives: the user and
// the source fallback are both dropped so no account identifier reaches the
// header, and no separator is left behind. Payloads, caches, and CLI output
// are never rewritten.

function displayUser(status) {
    return status.user || '';
}

export function providerHeader(status, showUserInfo = true) {
    const plan = status.plan || '';
    if (!showUserInfo)
        return plan;
    return [plan, displayUser(status)].filter(Boolean).join(' · ') || status.source || '';
}
