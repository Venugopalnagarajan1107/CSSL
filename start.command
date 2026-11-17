#!/bin/bash
# ====================================================================
#  Tournament app – one-click launcher for macOS
#
#    ./start.command              start the app + create a PUBLIC link (default)
#    ./start.command --local      this Wi-Fi only, no public link
#    ./start.command --reset-pin  set a new admin PIN (if you forgot it)
#
#  Double-clicking this file in Finder works too.
#  The public link lets everyone join from ANY network (home, mobile data).
#  Stable link: set up Tailscale Funnel once (see README) – the script
#  uses it automatically. Otherwise a free Cloudflare link is used; that
#  link changes every time you start, so start the app once and leave
#  it running until the event is over.
# ====================================================================
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3000}"
export PORT
MODE="public"; STRICT=""
case "$1" in
  --stable) STRICT=1 ;;
  --local) MODE="local" ;;
  --reset-pin)
    command -v node >/dev/null 2>&1 || { echo "Node.js is not installed yet. Run ./start.command once first."; exit 1; }
    [ -d node_modules ] || npm install --no-audit --no-fund >/dev/null 2>&1
    node server.js --reset-pin "$2"
    exit $? ;;
esac

pause() { read -r -p "Press Enter to close..." _; }

# ---- 1. Node.js -----------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew..."
    brew install node || { pause; exit 1; }
  else
    echo "Please install Node.js (LTS) from https://nodejs.org , then run this again."
    open "https://nodejs.org" 2>/dev/null
    pause; exit 1
  fi
fi

# ---- 2. dependencies (re-installs automatically after an update) ----
if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ] || [ ! -d node_modules/qrcode ]; then
  echo "Installing / updating dependencies (needs internet, about a minute)..."
  npm install --no-audit --no-fund || { echo "npm install failed"; pause; exit 1; }
fi

# ---- 3. cloud copy of the data (iCloud Drive, if you use it) --------
ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
if [ -z "$BACKUP_COPY_DIR" ] && [ -d "$ICLOUD" ]; then
  export BACKUP_COPY_DIR="$ICLOUD/TournamentBackup"
  echo "Backups are also copied to iCloud Drive > TournamentBackup"
fi

# ---- 3b. encrypt the backup copies (they contain phone numbers) -----
KEYFILE="$HOME/.tournament-backup-key"
if [ -z "$BACKUP_PASSPHRASE" ]; then
  if [ ! -f "$KEYFILE" ]; then
    ( umask 077; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32 > "$KEYFILE" )
    echo ""
    echo "A backup password was created and saved in:  $KEYFILE"
    echo "Copy it somewhere safe (password manager). Without it the encrypted"
    echo "backup copies cannot be opened if this Mac is lost."
    echo ""
  fi
  export BACKUP_PASSPHRASE="$(cat "$KEYFILE")"
fi

# ---- 4. housekeeping ------------------------------------------------
TUNNEL_PID=""; TS_BIN=""; USED_TS=""
cleanup() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  [ -n "$USED_TS" ] && "$TS_BIN" funnel reset >/dev/null 2>&1
  exit 0
}
trap cleanup INT TERM EXIT
if command -v caffeinate >/dev/null 2>&1; then caffeinate -dims -w $$ & fi   # keep the Mac awake

show_link() {   # $1 = url
  PREV="$(cat .public-link.txt 2>/dev/null)"
  if [ -n "$PREV" ] && [ "$PREV" != "$1" ]; then
    echo ""
    echo "  !!! WARNING: the public link CHANGED since the last run."
    echo "  !!! Old links, QR codes and WhatsApp messages no longer work: $PREV"
    echo "  !!! Share the new one below. For a link that never changes, set up Tailscale Funnel (free) – see README."
  fi
  echo ""
  echo "  ============================================================"
  echo "   PUBLIC LINK (share with everyone):  $1"
  echo "  ============================================================"
  node -e "require('qrcode').toString(process.argv[1],{type:'terminal',small:true},(e,s)=>{if(!e)console.log(s)})" "$1" 2>/dev/null
  printf "%s" "$1" | pbcopy 2>/dev/null && echo "  (link copied to your clipboard – open it on the Mac and use Menu > Share for a QR / WhatsApp)"
  echo "$1" > .public-link.txt
}

# ---- 5. public link -------------------------------------------------
if [ "$MODE" = "public" ]; then
  # 5a. Tailscale Funnel = stable https link (free, one-time setup)
  if command -v tailscale >/dev/null 2>&1; then TS_BIN="$(command -v tailscale)"
  elif [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then TS_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"; fi
  if [ -n "$TS_BIN" ]; then
    OUT="$("$TS_BIN" funnel --bg "$PORT" 2>&1)"
    URL="$(printf "%s" "$OUT" | grep -o 'https://[A-Za-z0-9.-]*\.ts\.net' | head -1)"
    if [ -n "$URL" ]; then USED_TS=1; show_link "$URL"
    else echo "Tailscale Funnel is not ready ($(printf "%s" "$OUT" | head -2 | tr '\n' ' ')). Trying Cloudflare instead..."; fi
  fi
  # 5b. Cloudflare quick tunnel = free, no account, link changes each start
  if [ -z "$USED_TS" ]; then
    if ! command -v cloudflared >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
      echo "Installing cloudflared (free tunnel tool) with Homebrew..."
      brew install cloudflared >/dev/null 2>&1
    fi
    if [ -n "$STRICT" ]; then
      echo ""
      echo "  !!! The permanent Tailscale link is NOT available, so the app will not start."
      echo "  !!! (A temporary link would break every QR code and message you already sent.)"
      echo "  !!! Run ./start-stable.command to fix Tailscale, then try again."
      pause; exit 1
    fi
    if command -v cloudflared >/dev/null 2>&1; then
      echo "  NOTE: this temporary link changes every time you restart. Do not print it on posters."
      echo "        For a permanent link: install Tailscale, enable Funnel, run ./start.command again."
      : > .tunnel.log
      cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate > .tunnel.log 2>&1 &
      TUNNEL_PID=$!
      ( for i in $(seq 1 60); do
          URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' .tunnel.log | head -1)"
          if [ -n "$URL" ]; then show_link "$URL"; break; fi
          sleep 1
        done ) &
    else
      echo ""
      echo "  Could not create a public link (cloudflared / Tailscale not available)."
      echo "  Install one:  brew install cloudflared   – then run ./start.command again."
      echo "  Continuing in Wi-Fi-only mode."
    fi
  fi
fi

( sleep 2; open "http://localhost:$PORT" ) >/dev/null 2>&1 &
node server.js
