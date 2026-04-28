# Netlify xhttp relay

Same architecture as the Vercel `api/proxy.js`, deployed to Netlify so we have a
second SNI-cover front (different platform, different IP space, different Iran
filter rules) for the same VPS xray backend.

## Deploy

```bash
cd netlify-relay
netlify login                    # browser auth, one-time
netlify init                     # create new site, link this folder
netlify env:set UPSTREAM_URL "http://138.201.175.71:8080"
netlify deploy --prod            # builds + deploys
```

The CLI prints the production URL after deploy. Note that — write it down.

## Verify

```bash
URL="https://<your-name>.netlify.app"
curl -I $URL/                              # 200 + cover HTML
curl -I $URL/proxy/                        # forwards to xray; 4xx is normal
                                           # (xray rejects non-VLESS HTTP)
```

End-to-end test using a current xray UUID:

```bash
# pick any UUID from clients.json
UUID=$(jq -r '.[0].id' ../clients.json)
NETLIFY_HOST=<your-name>.netlify.app

# kubernetes.io is the SNI cover (Netlify-hosted, Iran-allowlisted)
cat > /tmp/netlify-test.json <<EOF
{
  "log": {"loglevel": "info"},
  "inbounds": [{
    "tag": "socks-in", "port": 10809, "listen": "127.0.0.1",
    "protocol": "socks", "settings": {"udp": false, "auth": "noauth"}
  }],
  "outbounds": [{
    "tag": "vless-out", "protocol": "vless",
    "settings": {"vnext": [{
      "address": "kubernetes.io", "port": 443,
      "users": [{"id": "$UUID", "encryption": "none"}]
    }]},
    "streamSettings": {
      "network": "xhttp", "security": "tls",
      "tlsSettings": {
        "serverName": "kubernetes.io", "alpn": ["h2"], "fingerprint": "chrome"
      },
      "xhttpSettings": {
        "host": "$NETLIFY_HOST", "path": "/proxy", "mode": "auto"
      }
    }
  }]
}
EOF
xray run -c /tmp/netlify-test.json &
sleep 3
curl --socks5-hostname 127.0.0.1:10809 https://api.ipify.org
# should print 138.201.175.71 (the VPS exit IP)
```

## VLESS link template

```
vless://<UUID>@kubernetes.io:443?
  encryption=none
  &security=tls
  &sni=kubernetes.io
  &alpn=h2
  &fp=chrome
  &type=xhttp
  &host=<NETLIFY_HOST>
  &path=%2Fproxy
  &mode=auto
#WLF-Netlify
```

Replace `<UUID>` and `<NETLIFY_HOST>`. URL-encode the `host` and `path` if any
of them contain reserved characters.
