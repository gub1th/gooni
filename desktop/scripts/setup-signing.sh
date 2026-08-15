#!/bin/bash
# Create the self-signed codesigning identity the desktop build signs with.
#
# Why this exists: macOS ties TCC grants (camera, Accessibility, Screen
# Recording) to a binary's code-signature identity. An unsigned or ad-hoc
# signed build gets a new identity every rebuild, so every rebuild re-prompts
# for every permission. A self-signed cert gives the app a STABLE designated
# requirement across rebuilds, so grants persist. No Apple Developer account
# involved.
#
# Idempotent: exits 0 immediately if the identity already exists.
# Run once per machine; electron-builder then finds it by name.

set -euo pipefail

IDENTITY="Gooni Dev Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
  echo "ok: identity '$IDENTITY' already present"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/ext.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Gooni Dev Signing
[v3]
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
basicConstraints = critical,CA:false
EOF

# 10-year self-signed cert with the codeSigning EKU codesign requires.
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/ext.cnf"

# Bundle to p12 so one import carries key+cert as an identity.
# Legacy PBE/MAC algos: macOS `security import` can't read OpenSSL 3's
# default (AES-256-CBC + SHA-256 MAC) p12 — "MAC verification failed".
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$IDENTITY" -out "$TMP/identity.p12" -passout pass:gooni \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1

# -T /usr/bin/codesign: pre-authorize codesign so builds don't GUI-prompt.
security import "$TMP/identity.p12" -k "$KEYCHAIN" -P gooni \
  -T /usr/bin/codesign -T /usr/bin/security

# Trust the cert for code signing in the USER trust domain (no sudo).
# May raise one GUI confirmation dialog on some setups.
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"

security find-identity -v -p codesigning | grep "$IDENTITY" \
  && echo "ok: identity '$IDENTITY' created"
