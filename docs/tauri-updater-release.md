# Tauri Updater Release Notes

Seasonal Management uses the Tauri v2 updater with signed Windows NSIS artifacts hosted on public GitHub Releases.

## One-time setup

1. Install Git and create the GitHub repository for this project.
2. Configure the updater endpoint for the repo:

```powershell
cd app
npm run release:repo -- <owner>/<repo>
```

This writes `https://github.com/<owner>/<repo>/releases/latest/download/latest.json` to `app/src-tauri/tauri.conf.json`.

3. Add this GitHub Actions secret:
   - `TAURI_SIGNING_PRIVATE_KEY`: content of `app/updater-private.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: leave empty unless the key is rotated with a password

The generated private key files are ignored by `.gitignore`. Keep a backup of `app/updater-private.key`; losing it means existing installs cannot trust future updates signed with a different key.

## Release flow

From `app/`, sync the app version:

```powershell
npm run release:version -- 0.2.0
```

Commit the version change, tag it, and push:

```powershell
git add .
git commit -m "chore: release 0.2.0"
git tag app-v0.2.0
git push origin main --tags
```

The GitHub Action builds the Windows x64 NSIS installer, signs the updater artifact, uploads the installer/signature, and publishes `latest.json` on the release.
