#!/bin/bash
# Everyday: saves your changes as a new version and uploads them to GitHub.
# Run:  bash git-save.command "what I changed"     (message is optional)
cd "$(dirname "$0")" || exit 1
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$($b shellenv)"; done
[ -d .git ] || { echo "Run  bash git-first-upload.command  first."; exit 1; }
git add -A
if git diff --cached --quiet; then echo "Nothing has changed since the last save."; else
  MSG="$*"; [ -z "$MSG" ] && read -r -p "Describe this change in a few words: " MSG; MSG=${MSG:-Update}
  git commit -q -m "$MSG" && echo "Saved version: $MSG"
fi
git pull --rebase -q origin main 2>/dev/null
git push -q origin main && echo "Uploaded to GitHub." || echo "Upload failed. Check your internet or run: gh auth login"
echo; git log --oneline -5
