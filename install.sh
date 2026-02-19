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

    if [ -w "$INSTALL_DIR" ]; then
        mv "$tmpfile" "${INSTALL_DIR}/${BINARY_NAME}"
    else
        echo "Elevated permissions required to install to ${INSTALL_DIR}"
        sudo mv "$tmpfile" "${INSTALL_DIR}/${BINARY_NAME}"
    fi

    # Prevent trap from trying to remove the moved file
    trap - EXIT

    echo "Successfully installed ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"

    if command -v "$BINARY_NAME" >/dev/null 2>&1; then
        "$BINARY_NAME" --version
    else
        echo "Note: ${INSTALL_DIR} may not be in your PATH" >&2
        echo "Run: export PATH=\"${INSTALL_DIR}:\$PATH\"" >&2
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
