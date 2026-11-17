# Working with Git and GitHub (first-timer guide)

**Git** keeps every saved version of your project. **GitHub** stores a copy online, so a lost laptop never loses the app.

## One-time setup
1. Open Terminal, go to the project folder, run: `bash git-first-upload.command`
2. Answer the prompts (your name, GitHub email, repository name). A browser opens once to sign in to GitHub.
3. You end with a **private** repository. Your live `data/` folder (PINs, phone numbers, photos) is never uploaded.

## Every time you change something
`bash git-save.command "what I changed"`

That makes a new version and uploads it. Do this after each working change, for example after adding a feature or fixing a bug.

## Handy things to know
- See the history: `git log --oneline`
- See what changed since the last save: `git status`
- Undo a change to one file you have not saved yet: `git checkout -- public/app.js`
- Go back to an earlier version for a look: `git checkout <code-from-git-log>`, then `git checkout main` to return
- Try a risky idea safely: `git checkout -b my-idea`. If it works, `git checkout main` then `git merge my-idea`. If not, `git checkout main` and forget it.
- Get the project on another Mac: `gh repo clone <your-username>/tournament-app`, then `npm install`, then `./start.command`. Your tournament data does not travel with the code; copy the `data/` folder separately if you need it.

## Rules of thumb
- Save small and often, with a message that says what changed.
- Never remove the `data/` line from `.gitignore`.
- Keep the repository private. It contains your app code, not secrets, but there is no reason to share it.
