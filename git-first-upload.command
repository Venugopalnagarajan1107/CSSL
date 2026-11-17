#!/bin/bash
# One-time: puts this project on GitHub (private) so it is backed up and versioned.
# Run:  bash git-first-upload.command      (or double-click it)
cd "$(dirname "$0")" || exit 1
say() { printf "\n\033[1m%s\033[0m\n" "$1"; }
fail() { printf "\n\033[31m%s\033[0m\n" "$1"; read -n 1 -s -r -p "Press any key to close"; exit 1; }

say "Step 1/6  Checking git"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install 2>/dev/null
  fail "macOS is installing its developer tools (a pop-up appeared). Wait for it to finish, then run this script again."
fi
git --version || fail "git is not available."

say "Step 2/6  Checking the GitHub tool (gh)"
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$($b shellenv)"; done
if ! command -v gh >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "Installing Homebrew (it may ask for your Mac password)..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || fail "Homebrew install failed."
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$($b shellenv)"; done
  fi
  brew install gh || fail "Could not install gh."
fi
gh --version | head -1

say "Step 3/6  Your name for commits"
if [ -z "$(git config --global user.name)" ]; then read -r -p "Your name (shown on your commits): " N; git config --global user.name "$N"; fi
if [ -z "$(git config --global user.email)" ]; then read -r -p "Your GitHub email: " E; git config --global user.email "$E"; fi
echo "Committing as: $(git config --global user.name) <$(git config --global user.email)>"

say "Step 4/6  Saving the first version locally"
[ -d .git ] || git init -b main >/dev/null
git add -A
if git diff --cached --quiet; then echo "Nothing new to commit."; else git commit -q -m "Tournament app v5: first upload" && echo "Committed."; fi
echo "Files being tracked: $(git ls-files | wc -l | tr -d ' ')  (live data/ and node_modules are excluded on purpose)"
if git ls-files | grep -q '^data/'; then fail "data/ would be uploaded. Stopping so your players' details stay private."; fi

say "Step 5/6  Sign in to GitHub"
if ! gh auth status >/dev/null 2>&1; then
  echo "A browser page will open. Sign in, approve, and paste the one-time code shown here."
  gh auth login -h github.com -p https -w || fail "GitHub sign-in did not finish."
fi
gh auth setup-git

say "Step 6/6  Creating the private repository and uploading"
read -r -p "Repository name [tournament-app]: " R; R=${R:-tournament-app}
if git remote get-url origin >/dev/null 2>&1; then
  git push -u origin main || fail "Push failed."
else
  gh repo create "$R" --private --source=. --remote=origin --push || fail "Could not create the repository (name already used?). Run again with another name."
fi
URL=$(gh repo view --json url -q .url 2>/dev/null)
say "Done. Your code is on GitHub (private): $URL"
echo "From now on, run:  bash git-save.command   to save and upload changes."
read -n 1 -s -r -p "Press any key to close"
