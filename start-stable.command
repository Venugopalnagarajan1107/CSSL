#!/bin/bash
# ====================================================================
#  Tournament app – ONE PERMANENT LINK (macOS)
#
#    ./start-stable.command              set everything up (first time) and start the app
#    ./start-stable.command --autostart  also start the app automatically whenever you log in
#    ./start-stable.command --no-autostart   remove automatic start
#
#  What it does, step by step (safe to run again any time):
#    1. installs Homebrew, Node.js and Tailscale if they are missing
#    2. opens Tailscale so you sign in (free account) and waits for you
#    3. turns on the permanent https link (Tailscale Funnel)
#    4. starts the app. If the permanent link cannot be made, the app
#       REFUSES to start instead of silently giving you a link that changes.
#  The link looks like  https://your-mac.your-tailnet.ts.net  and stays
#  the same after every restart.
# ====================================================================
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
PORT="${PORT:-3000}"
pause() { read -r -p "Press Enter to close..." _; }
say() { printf "\n\033[1m%s\033[0m\n" "$1"; }
die() { printf "\n\033[31m%s\033[0m\n" "$1"; pause; exit 1; }

PLIST="$HOME/Library/LaunchAgents/com.tournament.app.plist"
if [ "$1" = "--no-autostart" ]; then
  launchctl unload "$PLIST" 2>/dev/null; rm -f "$PLIST"
  echo "Automatic start removed."; exit 0
fi

# ---- 1. tools ----------------------------------------------------------
say "1/4  Checking tools (Homebrew, Node.js, Tailscale)"
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$($b shellenv)"; done
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew (the Mac app installer) is missing. Installing it – it asks for your Mac password."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || die "Homebrew could not be installed. Install it from https://brew.sh and run this again."
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$($b shellenv)"; done
fi
command -v node >/dev/null 2>&1 || { echo "Installing Node.js..."; brew install node || die "Node.js install failed."; }
TS_APP="/Applications/Tailscale.app"
TS_BIN=""
find_ts() {
  if command -v tailscale >/dev/null 2>&1; then TS_BIN="$(command -v tailscale)"
  elif [ -x "$TS_APP/Contents/MacOS/Tailscale" ]; then TS_BIN="$TS_APP/Contents/MacOS/Tailscale"; fi
}
find_ts
if [ -z "$TS_BIN" ]; then
  echo "Installing Tailscale..."
  brew install --cask tailscale || die "Tailscale install failed. Download it from https://tailscale.com/download and run this again."
  find_ts
fi
[ -n "$TS_BIN" ] || die "Tailscale was installed but cannot be found. Open it once from Applications, then run this again."

# ---- 2. sign in --------------------------------------------------------
say "2/4  Signing in to Tailscale"
running() { "$TS_BIN" status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; }
if ! running; then
  open -a Tailscale 2>/dev/null
  echo "Tailscale is opening. In the Tailscale window or the menu-bar icon: click 'Log in' (a free account – Google or Microsoft login works)."
  echo "Approve any macOS pop-ups (VPN configuration / system extension). Waiting up to 5 minutes..."
  for i in $(seq 1 100); do running && break; sleep 3; done
  running || die "Tailscale is not signed in yet. Sign in, then run this again."
fi
echo "Signed in."

# ---- 3. permanent link -------------------------------------------------
say "3/4  Turning on the permanent link"
open_help() {
  echo ""
  echo "  One-time settings (free) – in the page that just opened:"
  echo "    • DNS page:  turn on  MagicDNS  and  HTTPS Certificates"
  echo "    • If Tailscale shows a link to enable 'Funnel', open it and click Enable."
  open "https://login.tailscale.com/admin/dns" 2>/dev/null
}
URL=""
LOG="$(mktemp -t tsfunnel)"
# "funnel" waits (does not return) until Funnel is allowed on your Tailscale account,
# so run it in the background, show what it says, and open the approval page for you.
"$TS_BIN" funnel --bg "$PORT" > "$LOG" 2>&1 &
FPID=$!
OPENED=""; SHOWN=0
echo "Waiting for Tailscale (up to 5 minutes)..."
for i in $(seq 1 150); do
  URL="$(grep -o 'https://[A-Za-z0-9.-]*\.ts\.net' "$LOG" | head -1)"
  [ -n "$URL" ] && break
  ENABLE="$(grep -o 'https://login.tailscale.com/[^ ]*' "$LOG" | head -1)"
  if [ -n "$ENABLE" ] && [ -z "$OPENED" ]; then
    OPENED=1
    echo ""
    echo "  Tailscale needs you to allow Funnel (one click, free):"
    echo "    1. In the page that is opening, sign in if asked and click ENABLE."
    echo "    2. Also open https://login.tailscale.com/admin/dns and make sure MagicDNS and HTTPS Certificates are ON."
    echo "    3. Come back here – this window continues by itself."
    echo ""
    open "$ENABLE" 2>/dev/null; open "https://login.tailscale.com/admin/dns" 2>/dev/null
  fi
  if ! kill -0 "$FPID" 2>/dev/null; then
    URL="$(grep -o 'https://[A-Za-z0-9.-]*\.ts\.net' "$LOG" | head -1)"
    if [ -z "$URL" ]; then
      # funnel exited: ask its status, then fall back to the machine's own address
      URL="$("$TS_BIN" funnel status 2>/dev/null | grep -o 'https://[A-Za-z0-9.-]*\.ts\.net' | head -1)"
      if [ -z "$URL" ]; then
        DNS="$("$TS_BIN" status --json 2>/dev/null | grep -m1 '"DNSName"' | sed 's/.*: *"\(.*\)".*/\1/; s/\.$//')"
        [ -n "$DNS" ] && URL="https://$DNS"
      fi
    fi
    break
  fi
  L="$(wc -l < "$LOG" | tr -d ' ')"
  if [ "$L" -gt "$SHOWN" ]; then sed -n "$((SHOWN+1)),${L}p" "$LOG"; SHOWN=$L; fi
  sleep 2
done
if [ -z "$URL" ]; then
  echo ""; echo "What Tailscale said:"; cat "$LOG"
  kill "$FPID" 2>/dev/null
fi
rm -f "$LOG"
[ -n "$URL" ] || die "Could not create the permanent link. Read the messages above, fix the setting they mention, and run this again."
echo "$URL" > .public-link.txt
echo ""
echo "  ============================================================"
echo "   YOUR PERMANENT LINK:  $URL"
echo "  ============================================================"
echo "  Put this on QR codes and in WhatsApp. It will not change."
printf "%s" "$URL" | pbcopy 2>/dev/null && echo "  (copied to your clipboard)"

# ---- optional: start automatically at login ----------------------------
if [ "$1" = "--autostart" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tournament.app</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HERE/start.command</string><string>--stable</string></array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HERE/autostart.log</string>
  <key>StandardErrorPath</key><string>$HERE/autostart.log</string>
</dict></plist>
PL
  launchctl unload "$PLIST" 2>/dev/null; launchctl load "$PLIST"
  echo ""
  echo "  Automatic start is ON: the app starts whenever you log in to this Mac and restarts if it stops."
  echo "  Turn it off with:  ./start-stable.command --no-autostart"
  echo "  (Keep the Mac plugged in, awake and online. Log file: autostart.log)"
  exit 0
fi

# ---- 4. start ----------------------------------------------------------
say "4/4  Starting the app"
exec /bin/bash ./start.command --stable
