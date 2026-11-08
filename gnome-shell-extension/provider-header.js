// Provider popup header helpers.
//
// The popup shows the plan next to the provider icon because the icon already
// identifies the provider. `showOrgName` only changes presentation: for
// Claude/Codex it removes the trailing "(workspace)" from Team/Business plan
// labels. Payloads, caches, and CLI output are never rewritten.

const ORG_PLAN_PROVIDERS = new Set(['claude', 'codex']);
const ORG_SUFFIX = /\s*\([^()]*\)\s*$/;

export function providerPlan(status, showOrgName = true) {
    const plan = status?.plan || status?.name || '';
    if (showOrgName || !ORG_PLAN_PROVIDERS.has(status?.key))
        return plan;
    return plan.replace(ORG_SUFFIX, '').trim();
}

export function providerUser(status, showUserInfo = true) {
    if (!showUserInfo)
        return '';
    return status?.user || '';
}

/**
 * The failure reason a card header offers as a hover tooltip: set for any
 * provider that is not OK and has an error message, whether or not the header
 * also shows a user label.  Empty when there is nothing to show.
 */
export function providerFailureMessage(status) {
    if (!status || status.state === 'ok' || !status.error)
        return '';
    return String(status.error);
}
