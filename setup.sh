#!/bin/bash
# ─────────────────────────────────────────────
# AI Assistant Mobile - Setup Script
# Generates self-signed SSL certificates
# and iOS .mobileconfig for HTTPS access
# ─────────────────────────────────────────────

set -e

CERT_DIR="./certs"
mkdir -p "$CERT_DIR"

# Tailscale / LAN IPs — add your own
read -p "Enter server IPs (comma-separated, e.g. 100.x.x.x,192.168.x.x): " IP_LIST
if [ -z "$IP_LIST" ]; then
  echo "No IPs provided. Using 127.0.0.1 only."
  IP_LIST="127.0.0.1"
fi

# Build SAN string
SAN="IP:127.0.0.1"
IFS=',' read -ra IPS <<< "$IP_LIST"
for ip in "${IPS[@]}"; do
  ip=$(echo "$ip" | xargs)  # trim whitespace
  [ "$ip" != "127.0.0.1" ] && SAN="$SAN,IP:$ip"
done

echo ""
echo "Generating certificates with SAN: $SAN"
echo ""

# 1. CA certificate (10 years)
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$CERT_DIR/ca.key" \
  -out "$CERT_DIR/ca.crt" \
  -subj "/CN=AI Assistant CA" 2>/dev/null

# 2. Server certificate
MSYS_NO_PATHCONV=1 openssl req -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.csr" \
  -subj "/CN=AI Assistant" 2>/dev/null

echo "subjectAltName=$SAN" > "$CERT_DIR/ext.cnf"

MSYS_NO_PATHCONV=1 openssl x509 -req \
  -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/server.crt" \
  -days 3650 \
  -extfile "$CERT_DIR/ext.cnf" 2>/dev/null

# 3. iOS mobileconfig
CA_B64=$(base64 -w 0 "$CERT_DIR/ca.crt" 2>/dev/null || base64 "$CERT_DIR/ca.crt")
UUID1=$(uuidgen 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || echo "A1B2C3D4-E5F6-7890-ABCD-EF1234567890")
UUID2=$(uuidgen 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || echo "B2C3D4E5-F6A7-8901-BCDE-F12345678901")

cat > "$CERT_DIR/ca.mobileconfig" << XMLEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>ca.crt</string>
      <key>PayloadContent</key>
      <data>${CA_B64}</data>
      <key>PayloadDescription</key>
      <string>CA certificate for AI Assistant HTTPS</string>
      <key>PayloadDisplayName</key>
      <string>AI Assistant CA</string>
      <key>PayloadIdentifier</key>
      <string>com.ai-assistant.ca</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${UUID1}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>AI Assistant CA</string>
  <key>PayloadDescription</key>
  <string>Install this to access AI Assistant via HTTPS</string>
  <key>PayloadIdentifier</key>
  <string>com.ai-assistant.profile</string>
  <key>PayloadOrganization</key>
  <string>AI Assistant</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${UUID2}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
XMLEOF

# Cleanup temp files
rm -f "$CERT_DIR/server.csr" "$CERT_DIR/ext.cnf" "$CERT_DIR/ca.srl"

echo ""
echo "========================================="
echo " Setup complete!"
echo "========================================="
echo ""
echo " Files created in $CERT_DIR/:"
echo "   ca.crt, ca.key        — CA certificate"
echo "   server.crt, server.key — Server certificate"
echo "   ca.mobileconfig        — iOS profile"
echo ""
echo " Next steps:"
echo "   1. cp config.example.json config.json"
echo "   2. Edit config.json (set username, password, claude path)"
echo "   3. npm install"
echo "   4. node server.js"
echo ""
echo " iOS setup:"
echo "   1. Open http://<your-ip>:9000/install in Safari"
echo "   2. Settings → General → VPN & Device Mgmt → Install"
echo "   3. Settings → General → About → Certificate Trust → Enable"
echo "   4. Access https://<your-ip>:9443"
echo ""
