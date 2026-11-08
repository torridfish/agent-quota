/**
 * The workspace ids a selection actually shows.  `rememberedIds` is the
 * remembered workspace list (`codex-workspace-options`), NOT the workspaces
 * that answered this cycle: a selected workspace whose fetch failed is still
 * remembered and must stay selected.  `configuredIds` is the saved
 * `codex-workspaces` list: empty means every remembered workspace, and a list
 * that matches no remembered workspace (only stale ids) also means every
 * remembered one, so Codex never ends up enabled with nothing to show.  A
 * list that matches some shows only those.  The popup, the status filter and
 * the settings page all use this one rule.
 */
export function effectiveWorkspaceIds(rememberedIds, configuredIds) {
    const remembered = [...new Set(rememberedIds)];
    const configured = new Set(configuredIds);
    if (!configured.size)
        return remembered;
    const chosen = remembered.filter(id => configured.has(id));
    return chosen.length ? chosen : remembered;
}

/**
 * Drop OK Codex statuses of workspaces the selection hides.  Failed Codex
 * statuses and other providers are always kept.  The selection is resolved
 * against `rememberedIds` (see effectiveWorkspaceIds); with nothing
 * remembered yet the workspaces that answered stand in for it.
 */
export function filterCodexStatuses(statuses, rememberedIds, configuredIds) {
    if (!configuredIds.length)
        return statuses;
    const okIds = statuses
        .filter(status => status.key === 'codex' && status.state === 'ok')
        .map(status => status.workspace_id);
    const shown = new Set(effectiveWorkspaceIds(
        rememberedIds.length ? rememberedIds : okIds,
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
    // A selection of only stale ids shows everything (effectiveWorkspaceIds),
    // so the toggle starts from "all", exactly as displayed.
    const baseline = available.some(id => configuredIds.includes(id)) ? configuredIds : [];
    const next = baseline.length
        ? new Set(baseline)
        : new Set(available);
    active ? next.add(workspaceId) : next.delete(workspaceId);

    const visible = available.filter(id => next.has(id));
    if (!visible.length)
        return null;

    const unavailable = [...new Set(baseline)].filter(id => !known.has(id));
    if (visible.length === available.length && !unavailable.length)
        return [];
    return [...visible, ...unavailable];
}
