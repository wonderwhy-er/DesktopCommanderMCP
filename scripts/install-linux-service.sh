#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="desktop-commander-device"
TARGET_USER="${SUDO_USER:-${USER:-}}"
DC_BINARY=""
START_SERVICE=false
ALLOW_ROOT=false
DRY_RUN=false
TEMP_UNIT=""

cleanup() {
  if [[ -n "${TEMP_UNIT}" ]]; then
    rm -f -- "${TEMP_UNIT}"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Install Desktop Commander Remote Device as a systemd service.

Usage: sudo desktop-commander linux-service [options]
  --user USER       Non-root Linux user that runs the service
  --bin PATH        Absolute path to the desktop-commander executable
  --service NAME    systemd service name
  --start           Start the service after installation
  --allow-root      Explicitly allow a root-owned service (not recommended)
  --dry-run         Validate and print the generated unit without installing
  -h, --help        Show this help
EOF
}

require_value() {
  if [[ $# -lt 2 || -z "${2:-}" ]]; then
    echo "Option $1 requires a value." >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) require_value "$@"; TARGET_USER="$2"; shift 2 ;;
    --bin) require_value "$@"; DC_BINARY="$2"; shift 2 ;;
    --service) require_value "$@"; SERVICE_NAME="$2"; shift 2 ;;
    --start) START_SERVICE=true; shift ;;
    --allow-root) ALLOW_ROOT=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer only supports Linux." >&2
  exit 1
fi

if [[ "${DRY_RUN}" != "true" && "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo or as root." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1 ||
   ! command -v systemd-analyze >/dev/null 2>&1; then
  echo "systemd is required but systemctl/systemd-analyze was not found." >&2
  exit 1
fi

if [[ -z "${TARGET_USER}" ]] || ! id "${TARGET_USER}" >/dev/null 2>&1; then
  echo "Linux user does not exist: ${TARGET_USER:-<empty>}" >&2
  exit 1
fi

if [[ "${TARGET_USER}" == "root" && "${ALLOW_ROOT}" != "true" ]]; then
  echo "Refusing to install a root-owned remote agent. Pass a non-root --user." >&2
  echo "Use --allow-root only when full host-level access is intentional." >&2
  exit 1
fi

if [[ ! "${SERVICE_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]*$ ]]; then
  echo "Invalid service name: ${SERVICE_NAME}" >&2
  exit 1
fi

TARGET_GROUP="$(id -gn "${TARGET_USER}")"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
if [[ -z "${TARGET_HOME}" || "${TARGET_HOME}" != /* ]]; then
  echo "Could not resolve an absolute home directory for ${TARGET_USER}." >&2
  exit 1
fi

find_user_binary() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "${TARGET_USER}" -- sh -lc 'command -v desktop-commander' || true
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "${TARGET_USER}" -H sh -lc 'command -v desktop-commander' || true
  elif command -v su >/dev/null 2>&1; then
    su -s /bin/sh "${TARGET_USER}" -c 'command -v desktop-commander' || true
  fi
}

if [[ -z "${DC_BINARY}" ]]; then
  DC_BINARY="$(command -v desktop-commander || true)"
fi
if [[ -z "${DC_BINARY}" ]]; then
  DC_BINARY="$(find_user_binary)"
fi

if [[ -z "${DC_BINARY}" || "${DC_BINARY}" != /* ]]; then
  echo "desktop-commander executable must be an absolute path. Pass --bin /absolute/path." >&2
  exit 1
fi

DC_BINARY="$(realpath -e -- "${DC_BINARY}")"
if [[ ! -x "${DC_BINARY}" ]]; then
  echo "desktop-commander executable is not executable: ${DC_BINARY}" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGED_TEMPLATE="${SCRIPT_DIR}/desktop-commander-device.service.template"
REPO_TEMPLATE="${SCRIPT_DIR}/../deploy/linux/desktop-commander-device.service.template"
if [[ -f "${PACKAGED_TEMPLATE}" ]]; then
  TEMPLATE="${PACKAGED_TEMPLATE}"
else
  TEMPLATE="${REPO_TEMPLATE}"
fi

if [[ ! -f "${TEMPLATE}" ]]; then
  echo "Service template not found: ${TEMPLATE}" >&2
  exit 1
fi

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
BINARY_DIR="$(dirname "${DC_BINARY}")"
SERVICE_PATH="${BINARY_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
TEMP_UNIT="$(mktemp "/tmp/${SERVICE_NAME}.XXXXXX.service")"

escape_unit_value() {
  printf '%s' "$1" | sed -e 's/%/%%/g' -e 's/[\\&|]/\\&/g'
}

sed \
  -e "s|__USER__|$(escape_unit_value "${TARGET_USER}")|g" \
  -e "s|__GROUP__|$(escape_unit_value "${TARGET_GROUP}")|g" \
  -e "s|__HOME__|$(escape_unit_value "${TARGET_HOME}")|g" \
  -e "s|__BINARY__|$(escape_unit_value "${DC_BINARY}")|g" \
  -e "s|__PATH__|$(escape_unit_value "${SERVICE_PATH}")|g" \
  "${TEMPLATE}" > "${TEMP_UNIT}"

systemd-analyze verify "${TEMP_UNIT}"

if [[ "${DRY_RUN}" == "true" ]]; then
  cat "${TEMP_UNIT}"
  exit 0
fi

install -m 0644 "${TEMP_UNIT}" "${UNIT_PATH}"
install -d -m 0700 -o "${TARGET_USER}" -g "${TARGET_GROUP}" \
  "${TARGET_HOME}/.desktop-commander-device" \
  "${TARGET_HOME}/.claude-server-commander"

systemctl daemon-reload
systemctl enable -- "${SERVICE_NAME}.service"

if [[ "${START_SERVICE}" == "true" ]]; then
  systemctl restart -- "${SERVICE_NAME}.service"
fi

cat <<EOF
Installed ${UNIT_PATH}
Service user: ${TARGET_USER}
Executable: ${DC_BINARY}

Next steps:
  sudo systemctl start ${SERVICE_NAME}
  sudo journalctl -u ${SERVICE_NAME} -f

The first start prints the device authorization URL and code in journalctl.
EOF
