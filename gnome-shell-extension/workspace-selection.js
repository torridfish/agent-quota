export function filterCodexStatuses(statuses, configuredIds) {
    const selected = new Set(configuredIds);
    if (!selected.size)
        return statuses;
    return statuses.filter(status => status.key !== 'codex' || status.state !== 'ok' ||
        selected.has(status.workspace_id));
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
