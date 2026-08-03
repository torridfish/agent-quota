#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bundle_dir="$(mktemp -d)"
extension_source="$(mktemp -d)"
trap 'rm -rf "${bundle_dir}" "${extension_source}"' EXIT

uuid="agent-quota@torridfish"
expected_version="$(sed -n 's/.*"version":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${repo_dir}/gnome-shell-extension/metadata.json")"
uv_command="$(command -v uv || true)"
if [ -z "${uv_command}" ] && [ -x "${HOME}/.local/bin/uv" ]; then
    uv_command="${HOME}/.local/bin/uv"
fi
if [ -z "${uv_command}" ]; then
    echo "uv is required to install Agent Quota." >&2
    exit 1
fi

# Keep the optional global CLI synchronized with the extension backend.
# --refresh-package is necessary while local development versions still share
# the same project version; otherwise uv can reuse an older cached wheel.
"${uv_command}" tool install --force --refresh-package agent-quota "${repo_dir}"

shell_extensions_dest="org.gnome.Shell.Extensions"
shell_extensions_path="/org/gnome/Shell/Extensions"

extension_info() {
    gdbus call --session \
        --dest "${shell_extensions_dest}" \
        --object-path "${shell_extensions_path}" \
        --method org.gnome.Shell.Extensions.GetExtensionInfo \
        "${uuid}"
}

wait_for_state() {
    expected="$1"
    for _ in $(seq 1 30); do
        info="$(extension_info 2>/dev/null || true)"
        if [ "${expected}" = "active" ] && printf '%s' "${info}" | grep -q "'state': <1.0>"; then
            return 0
        fi
        # A failed extension remains in GNOME Shell's ERROR state even after
        # DisableExtension succeeds.  It is still disabled and safe to
        # replace, so do not block a repair install waiting for state 2.
        if [ "${expected}" = "inactive" ] && { printf '%s' "${info}" | grep -q "'state': <2.0>" || printf '%s' "${info}" | grep -q "'enabled': <false>"; }; then
            return 0
        fi
        sleep 0.2
    done
    echo "GNOME Shell did not reach ${expected} state for ${uuid}" >&2
    extension_info >&2 || true
    return 1
}

wait_for_version() {
    for _ in $(seq 1 30); do
        info="$(extension_info 2>/dev/null || true)"
        if printf '%s' "${info}" | grep -q "'version': <${expected_version}.0>"; then
            return 0
        fi
        sleep 0.2
    done
    echo "Files installed, but GNOME Shell is still running an older extension module." >&2
    echo "Expected module version: ${expected_version}; Shell currently reports:" >&2
    extension_info >&2 || true
    echo "On GNOME 50 Wayland, log out and back in once to load the new module." >&2
    return 1
}

# A real disable/enable cycle makes GNOME unload and recreate the GJS module.
# GetExtensionInfo returns exit 0 with "(@a{sv} {},)" when the extension is not installed, so check the payload, not the exit status.
existing_info="$(extension_info 2>/dev/null || true)"
if [ -n "${existing_info}" ] && [ "${existing_info}" != "(@a{sv} {},)" ]; then
    gdbus call --session \
        --dest "${shell_extensions_dest}" \
        --object-path "${shell_extensions_path}" \
        --method org.gnome.Shell.Extensions.DisableExtension \
        "${uuid}" >/dev/null
    wait_for_state inactive
fi

# Bundle the backend with the extension. The Shell calls it through `uv run`,
# so users do not need to install the separate `agent-quota` command first.
cp -R "${repo_dir}/gnome-shell-extension/." "${extension_source}/"
cp "${repo_dir}/agent_quota.py" "${repo_dir}/common.py" "${repo_dir}/pyproject.toml" \
    "${repo_dir}/README.md" "${extension_source}/"
cp -R "${repo_dir}/providers" "${extension_source}/providers"

gnome-extensions pack -f \
    --schema="${extension_source}/schemas/org.gnome.shell.extensions.agent-quota.gschema.xml" \
    -o "${bundle_dir}" "${extension_source}" >/dev/null
# gnome-extensions pack deliberately includes only the standard extension
# assets. Add the extension-local Python backend after packing.
(
    cd "${extension_source}"
    zip -q -ur "${bundle_dir}/agent-quota@torridfish.shell-extension.zip" \
        agent_quota.py common.py pyproject.toml README.md providers \
        gauge-symbolic.svg icons
)
gnome-extensions install --force "${bundle_dir}/agent-quota@torridfish.shell-extension.zip"

user_data_dir="${XDG_DATA_HOME:-${HOME}/.local/share}"
installed_schema_dir="${user_data_dir}/gnome-shell/extensions/${uuid}/schemas"
glib-compile-schemas "${installed_schema_dir}"

# Persist the enable flag so the next session auto-loads the extension even
# if the running Shell cannot load a brand-new extension in-process.
# gsettings takes SCHEMA and KEY as two separate arguments; passing them as one
# string silently turns this whole block into a no-op.
enabled_schema="org.gnome.shell"
enabled_key="enabled-extensions"
persist_enabled_flag() {
    current_enabled="$(gsettings get "${enabled_schema}" "${enabled_key}" 2>/dev/null || true)"
    if printf '%s' "${current_enabled}" | grep -q "'${uuid}'"; then
        return 0
    fi
    if [ -n "${current_enabled}" ] && [ "${current_enabled}" != "[]" ] && [ "${current_enabled}" != "@as []" ]; then
        new_enabled="$(printf '%s' "${current_enabled}" | sed "s/^\[/['${uuid}', /")" || return 1
    else
        new_enabled="['${uuid}']"
    fi
    gsettings set "${enabled_schema}" "${enabled_key}" "${new_enabled}"
}
persist_enabled_flag || echo "Could not persist ${uuid} in ${enabled_schema} ${enabled_key}." >&2

enable_extension() {
    gdbus call --session \
        --dest "${shell_extensions_dest}" \
        --object-path "${shell_extensions_path}" \
        --method org.gnome.Shell.Extensions.EnableExtension \
        "${uuid}" 2>&1
}

# `gnome-extensions install --force` makes the Shell unload and reload the
# extension, so GetExtensionInfo transiently returns "(@a{sv} {},)" and an
# EnableExtension issued inside that window is lost.  Keep retrying until the
# Shell reports the extension as enabled instead of judging on a single probe.
enable_error=""
for _ in $(seq 1 25); do
    info="$(extension_info 2>/dev/null || true)"
    if [ -n "${info}" ] && [ "${info}" != "(@a{sv} {},)" ]; then
        if printf '%s' "${info}" | grep -q "'enabled': <true>"; then
            break
        fi
        enable_error="$(enable_extension)" || true
    fi
    sleep 0.2
done

# GNOME 50 Wayland cannot load a brand-new extension in the running session: GetExtensionInfo keeps returning "(@a{sv} {},)", so the active/version waits below would always time out.
info_after_enable="$(extension_info 2>/dev/null || true)"
if [ -z "${info_after_enable}" ] || [ "${info_after_enable}" = "(@a{sv} {},)" ]; then
    echo "Installed ${uuid} version ${expected_version} for the next session." >&2
    echo "GNOME Shell on this Wayland session cannot load a brand-new extension in place." >&2
    echo "Log out and back in once; Agent Quota will appear in the top bar." >&2
    exit 0
fi
if [ -n "${enable_error}" ] && ! printf '%s' "${info_after_enable}" | grep -q "'enabled': <true>"; then
    echo "EnableExtension failed: ${enable_error}" >&2
fi

wait_for_state active
wait_for_version

errors="$(gdbus call --session \
    --dest "${shell_extensions_dest}" \
    --object-path "${shell_extensions_path}" \
    --method org.gnome.Shell.Extensions.GetExtensionErrors \
    "${uuid}")"
if [ "${errors}" != "(@as [],)" ]; then
    echo "GNOME Shell reported extension errors: ${errors}" >&2
    exit 1
fi

echo "Installed Agent Quota GNOME extension"
echo "Installed the matching global agent-quota CLI and bundled extension backend."
echo "Installed and verified ${uuid} version ${expected_version} is ACTIVE"
