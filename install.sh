#!/bin/sh
set -e

# Cascade installer
# Usage: curl -sSL https://raw.githubusercontent.com/marcelsud/cascade/main/install.sh | sh

REPO="marcelsud/cascade"
BINARY_NAME="cascade"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

main() {
    check_prerequisites
    check_platform
    ensure_runtime_compatibility
    ensure_install_dir

    echo "Installing ${BINARY_NAME} to ${INSTALL_DIR}..."

    tmpfile=$(mktemp)
    trap 'rm -f "$tmpfile"' EXIT

    download_url="https://github.com/${REPO}/releases/latest/download/${BINARY_NAME}"

    http_code=$(curl -sL -o "$tmpfile" -w "%{http_code}" "$download_url")
    if [ "$http_code" != "200" ]; then
        echo "Error: Download failed with HTTP status ${http_code}" >&2
        echo "URL: ${download_url}" >&2
        exit 1
    fi

    if [ ! -s "$tmpfile" ]; then
        echo "Error: Downloaded file is empty" >&2
        exit 1
    fi

    chmod +x "$tmpfile"

    if ! installed_version=$("$tmpfile" --version 2>&1); then
        echo "Error: The downloaded Cascade binary is incompatible with this system." >&2
        echo "$installed_version" >&2
        exit 1
    fi

    if [ -w "$INSTALL_DIR" ]; then
        mv "$tmpfile" "${INSTALL_DIR}/${BINARY_NAME}"
    else
        echo "Elevated permissions required to install to ${INSTALL_DIR}"
        sudo mv "$tmpfile" "${INSTALL_DIR}/${BINARY_NAME}"
    fi

    # Prevent trap from trying to remove the moved file
    trap - EXIT

    echo "Successfully installed ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"

    echo "$installed_version"

    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*) ;;
        *)
            echo "Note: ${INSTALL_DIR} may not be in your PATH" >&2
            echo "Run: export PATH=\"${INSTALL_DIR}:\$PATH\"" >&2
            ;;
    esac
}

ensure_runtime_compatibility() {
    libc=$(ldd --version 2>&1 || true)

    case "$libc" in
        *musl*)
            if [ -e /lib64/ld-linux-x86-64.so.2 ]; then
                return
            fi

            if ! command -v apk >/dev/null 2>&1; then
                echo "Error: Cascade requires Linux x86-64 with glibc compatibility." >&2
                exit 1
            fi

            echo "Linux x86-64 with glibc. Alpine Linux requires gcompat."

            if [ ! -t 1 ]; then
                echo "Error: Cannot prompt to install gcompat without an interactive terminal." >&2
                echo "Install it with: apk add --no-cache gcompat" >&2
                exit 1
            fi

            printf "Do you want to install it? (y/N) " > /dev/tty
            answer=
            IFS= read -r answer < /dev/tty || true

            case "$answer" in
                y|Y|yes|YES|Yes)
                    if [ "$(id -u)" -eq 0 ]; then
                        apk add --no-cache gcompat
                    elif command -v sudo >/dev/null 2>&1; then
                        sudo apk add --no-cache gcompat
                    else
                        echo "Error: Root access is required to install gcompat." >&2
                        exit 1
                    fi
                    ;;
                *)
                    echo "Installation cancelled."
                    exit 1
                    ;;
            esac

            if [ ! -e /lib64/ld-linux-x86-64.so.2 ]; then
                echo "Error: gcompat did not provide the required glibc loader." >&2
                exit 1
            fi
            ;;
    esac
}

ensure_install_dir() {
    if [ -d "$INSTALL_DIR" ]; then
        return
    fi

    if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
        echo "Elevated permissions required to create ${INSTALL_DIR}"
        sudo mkdir -p "$INSTALL_DIR"
    fi
}

check_prerequisites() {
    if ! command -v curl >/dev/null 2>&1; then
        echo "Error: curl is required but not installed" >&2
        exit 1
    fi
}

check_platform() {
    os=$(uname -s)
    arch=$(uname -m)

    if [ "$os" != "Linux" ]; then
        echo "Error: Unsupported operating system: ${os}" >&2
        echo "Cascade currently supports Linux only" >&2
        exit 1
    fi

    if [ "$arch" != "x86_64" ]; then
        echo "Error: Unsupported architecture: ${arch}" >&2
        echo "Cascade currently supports x86_64 (amd64) only" >&2
        exit 1
    fi
}

main
