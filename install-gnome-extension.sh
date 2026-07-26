#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bundle_dir="$(mktemp -d)"
trap 'rm -rf "${bundle_dir}"' EXIT

uuid="agent-quota@torridfish"
expected_version="$(sed -n 's/.*"version":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${repo_dir}/gnome-shell-extension/metadata.json")"

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
        if [ "${expected}" = "inactive" ] && printf '%s' "${info}" | grep -q "'state': <2.0>"; then
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
if extension_info >/dev/null 2>&1; then
    gdbus call --session \
        --dest "${shell_extensions_dest}" \
        --object-path "${shell_extensions_path}" \
        --method org.gnome.Shell.Extensions.DisableExtension \
        "${uuid}" >/dev/null
    wait_for_state inactive
fi

gnome-extensions pack -f \
    --extra-source="${repo_dir}/gnome-shell-extension/gauge-symbolic.svg" \
    -o "${bundle_dir}" "${repo_dir}/gnome-shell-extension" >/dev/null
gnome-extensions install --force "${bundle_dir}/agent-quota@torridfish.shell-extension.zip"

gdbus call --session \
    --dest "${shell_extensions_dest}" \
    --object-path "${shell_extensions_path}" \
    --method org.gnome.Shell.Extensions.EnableExtension \
    "${uuid}" >/dev/null
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
echo "Install the command first with: uv tool install ${repo_dir}"
echo "Installed and verified ${uuid} version ${expected_version} is ACTIVE"
