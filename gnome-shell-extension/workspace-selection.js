/**
 * The workspace ids a selection actually shows.  `configuredIds` is the saved
 * `codex-workspaces` list: empty means every available workspace, and a list
 * that matches no available workspace (only stale ids) also means every
 * available one, so Codex never ends up enabled with nothing to show.  A
 * list that matches some shows only those.  The popup and the settings page
 * both use this rule.
 */
export function effectiveWorkspaceIds(availableIds, configuredIds) {
    const available = [...new Set(availableIds)];
    const configured = new Set(configuredIds);
    if (!configured.size)
        return available;
    const chosen = available.filter(id => configured.has(id));
    return chosen.length ? chosen : available;
}

export function filterCodexStatuses(statuses, configuredIds) {
    if (!configuredIds.length)
        return statuses;
    const shown = new Set(effectiveWorkspaceIds(
        statuses
            .filter(status => status.key === 'codex' && status.state === 'ok')
            .map(status => status.workspace_id),
        configuredIds,
    ));
    return statuses.filter(status => status.key !== 'codex' || status.state !== 'ok' ||
        shown.has(status.workspace_id));
}

export function selectionAfterWorkspaceToggle(
    availableIds,
    configuredIds,
    workspaceId,
    active,
) {
    const available = [...new Set(availableIds)];
    const known = new Set(available);
    const next = configuredIds.length
        ? new Set(configuredIds)
        : new Set(available);
    active ? next.add(workspaceId) : next.delete(workspaceId);

    const visible = available.filter(id => next.has(id));
    if (!visible.length)
        return null;

    const unavailable = [...new Set(configuredIds)].filter(id => !known.has(id));
    if (visible.length === available.length && !unavailable.length)
        return [];
    return [...visible, ...unavailable];
}
