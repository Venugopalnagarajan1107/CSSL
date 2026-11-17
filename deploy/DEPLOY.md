# Run the tournament app without your Mac (free, always on)

The Mac is fine for a trial, but a laptop that sleeps or loses Wi-Fi takes the live scores down.
A small free cloud server stays on, has a permanent https address, and restarts itself.

## Option A – free VM (recommended)
Two big providers give a permanent free small VM. Both ask for a card to verify you (nothing is charged on the free tier):
- **Oracle Cloud "Always Free"** – an Ubuntu VM (choose the Ampere A1 or AMD micro shape).
- **Google Cloud "Free Tier" e2-micro** – Ubuntu, in a US region (us-west1 / us-central1 / us-east1).

Steps (about 30 minutes, once):
1. Create the VM with **Ubuntu 22.04**, and let it have a public IP. In the provider's firewall / security list allow **TCP 80 and 443** (and 22 for SSH).
2. Get a free name at **duckdns.org** (sign in, pick e.g. `mysportsday`, set its IP to the VM's public IP). Your link becomes `https://mysportsday.duckdns.org`.
3. Copy the app to the VM (from your Mac, in the folder that contains `tournament-app`):
   `scp -r tournament-app <user>@<VM-IP>:~/`
4. On the VM:
   `cd ~/tournament-app && bash deploy/vm-setup.sh mysportsday.duckdns.org`
5. It prints the link, the **first admin PIN** and the **backup password** – write both down.

It installs Node and Caddy (automatic free HTTPS), runs the app as a locked-down service that restarts on crashes and reboots, opens only ports 22/80/443, and keeps **encrypted** backups every 2 minutes in `/var/lib/tournament/backups`.

To update later: copy the new version over and run the same command again – your data is kept.
Before the event also tap **Admin → Data → Download backup** and keep the file on your phone/laptop (that copy is off the server).

## Option B – any Docker host
`docker build -t tournament . && docker run -d -p 3000:3000 -v tournament-data:/data -e BACKUP_PASSPHRASE=choose-a-long-secret tournament`
Put https in front (most hosts do this for you). **The /data disk must be persistent.**
Free web-hosting plans that wipe their disk on restart (Render's free tier, for example) will lose your data – avoid those, or restore from your downloaded backup after each restart.

## Option C – the Mac (as before)
`./start.command` still works. Use it for rehearsals or as a back-up plan.

## Good to know
- Everyone's IP address is read from the https proxy (Caddy / Tailscale / Cloudflare), so the sign-in lockout only blocks the person guessing, not the whole venue.
- Pause, resume or move later: **Admin → Data → Download backup**, then **Restore backup** on the new server.
- Encrypted backup files end in `.enc`. Open one with `BACKUP_PASSPHRASE=… node server.js --decrypt <file>`.
