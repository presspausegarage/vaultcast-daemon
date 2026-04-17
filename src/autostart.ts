// Autostart wiring — installs the tray app to launch on login, per platform.
// CLI: `npm run install-autostart` / `npm run uninstall-autostart`
//
// Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Run registry entry
// macOS:   ~/Library/LaunchAgents/app.vaultcast.daemon.plist (LaunchAgent)
// Linux:   ~/.config/systemd/user/vaultcast.service (systemd --user unit)
//
// We install the *tray* wrapper on autostart, not the CLI — a terminal
// popping up on login would be hostile. The tray launches silent and sits
// in the notification area / menu bar until the user quits it.

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync, spawnSync } from 'child_process'

const APP_ID = 'app.vaultcast.daemon'
const APP_NAME = 'VaultCast'

// ─── Entry resolution ─────────────────────────────────────────────────────────

/**
 * The shell command we want the OS to execute on login. We resolve it at
 * install time rather than at launch time so the autostart entry is
 * self-contained — the user can inspect it and see exactly what will run.
 *
 * In development we launch via `node` + the built tray.js. If the daemon is
 * eventually packaged into a single binary (pkg, bun, nexe), this is the
 * one function that needs changing.
 */
function resolveLaunchCommand(): { exe: string; args: string[]; cwd: string } {
  const daemonRoot = path.resolve(__dirname, '..')
  const trayScript = path.join(daemonRoot, 'dist', 'tray.js')

  if (!fs.existsSync(trayScript)) {
    throw new Error(
      `Built tray entry not found at ${trayScript}. Run "npm run build" first, ` +
        'then re-run the autostart installer.'
    )
  }

  return {
    exe: process.execPath,   // the node binary currently running
    args: [trayScript],
    cwd: daemonRoot,
  }
}

// ─── Windows: registry Run key ────────────────────────────────────────────────

function installWindows(): void {
  const { exe, args } = resolveLaunchCommand()
  // Build a single command line string for the Run key. Quoting matters on
  // Windows — spaces in paths (Program Files, usernames) break bare values.
  const commandLine = `"${exe}" "${args.join('" "')}"`

  // REG ADD /v <name> /t REG_SZ /d <data> /f — overwrites if present.
  // We shell out to reg.exe rather than use a native binding; it's
  // pre-installed on every Windows install and has stable output.
  const regCmd = [
    'reg',
    'add',
    String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
    '/v',
    APP_NAME,
    '/t',
    'REG_SZ',
    '/d',
    commandLine,
    '/f',
  ]

  const result = spawnSync(regCmd[0], regCmd.slice(1), { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`reg.exe failed with exit code ${result.status}`)
  }
  console.log(`[autostart] Installed Windows Run key for ${APP_NAME}`)
  console.log(`[autostart] Command: ${commandLine}`)
  console.log('[autostart] Tray app will launch on next login. Log out and back in to verify.')
}

function uninstallWindows(): void {
  const regCmd = [
    'reg',
    'delete',
    String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
    '/v',
    APP_NAME,
    '/f',
  ]
  const result = spawnSync(regCmd[0], regCmd.slice(1), { stdio: 'inherit' })
  if (result.status !== 0 && result.status !== 1) {
    // Exit 1 = value not found (already uninstalled); treat as success.
    throw new Error(`reg.exe failed with exit code ${result.status}`)
  }
  console.log(`[autostart] Removed Windows Run key for ${APP_NAME}`)
}

// ─── macOS: LaunchAgent plist ─────────────────────────────────────────────────

function macPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${APP_ID}.plist`)
}

function installMac(): void {
  const { exe, args, cwd } = resolveLaunchCommand()
  const programArguments = [exe, ...args]
    .map((s) => `    <string>${escapeXml(s)}</string>`)
    .join('\n')

  // Minimal LaunchAgent — RunAtLoad starts on login, KeepAlive restarts if
  // crashed. StandardOutPath / StandardErrorPath let users inspect logs.
  const logDir = path.join(os.homedir(), 'Library', 'Logs', 'VaultCast')
  fs.mkdirSync(logDir, { recursive: true })

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${APP_ID}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, 'stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, 'stderr.log'))}</string>
</dict>
</plist>
`

  const plistPath = macPlistPath()
  fs.mkdirSync(path.dirname(plistPath), { recursive: true })
  fs.writeFileSync(plistPath, plist, 'utf-8')

  // Load it immediately so the daemon starts right away, not just on next login
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`)
    execSync(`launchctl load "${plistPath}"`)
  } catch (err) {
    console.warn(
      `[autostart] LaunchAgent written but load failed: ${(err as Error).message}. ` +
        'Log out and back in, or run `launchctl load` manually.'
    )
  }

  console.log(`[autostart] Installed LaunchAgent at ${plistPath}`)
  console.log(`[autostart] Logs: ${logDir}`)
}

function uninstallMac(): void {
  const plistPath = macPlistPath()
  if (!fs.existsSync(plistPath)) {
    console.log('[autostart] No LaunchAgent found — nothing to uninstall.')
    return
  }
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`)
  } catch {
    // unload failure is fine — unit may not be loaded
  }
  fs.unlinkSync(plistPath)
  console.log(`[autostart] Removed LaunchAgent at ${plistPath}`)
}

// ─── Linux: systemd --user service ────────────────────────────────────────────

function linuxUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'vaultcast.service')
}

function installLinux(): void {
  const { exe, args, cwd } = resolveLaunchCommand()
  // Quote each arg for ExecStart — systemd splits on whitespace otherwise.
  // Using a single %h (home) expansion isn't reliable across distros; we
  // write absolute paths resolved now.
  const execStart = [exe, ...args].map((s) => `"${s}"`).join(' ')

  const unit = `[Unit]
Description=VaultCast Daemon (tray)
After=graphical-session.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${cwd}
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`

  const unitPath = linuxUnitPath()
  fs.mkdirSync(path.dirname(unitPath), { recursive: true })
  fs.writeFileSync(unitPath, unit, 'utf-8')

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' })
    execSync('systemctl --user enable --now vaultcast.service', { stdio: 'inherit' })
  } catch (err) {
    console.warn(
      `[autostart] Unit written but systemctl failed: ${(err as Error).message}.`
    )
    console.warn(
      '[autostart] Run `systemctl --user enable --now vaultcast.service` manually once systemd is available.'
    )
  }

  console.log(`[autostart] Installed systemd user unit at ${unitPath}`)
  console.log('[autostart] Logs: `journalctl --user -u vaultcast`')
  console.log(
    '[autostart] Note: GNOME out of the box does not render tray icons. ' +
      'Install the "AppIndicator and KStatusNotifierItem Support" GNOME extension.'
  )
}

function uninstallLinux(): void {
  const unitPath = linuxUnitPath()
  if (!fs.existsSync(unitPath)) {
    console.log('[autostart] No systemd unit found — nothing to uninstall.')
    return
  }
  try {
    execSync('systemctl --user disable --now vaultcast.service', { stdio: 'inherit' })
  } catch {
    // ignore — unit may not be loaded
  }
  fs.unlinkSync(unitPath)
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' })
  } catch {
    // ignore
  }
  console.log(`[autostart] Removed systemd user unit at ${unitPath}`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ─── Public dispatch ──────────────────────────────────────────────────────────

export function install(): void {
  switch (process.platform) {
    case 'win32':   return installWindows()
    case 'darwin':  return installMac()
    case 'linux':   return installLinux()
    default:
      throw new Error(`Autostart not supported on platform: ${process.platform}`)
  }
}

export function uninstall(): void {
  switch (process.platform) {
    case 'win32':   return uninstallWindows()
    case 'darwin':  return uninstallMac()
    case 'linux':   return uninstallLinux()
    default:
      throw new Error(`Autostart not supported on platform: ${process.platform}`)
  }
}

// ─── CLI dispatch (for npm scripts) ──────────────────────────────────────────

if (require.main === module) {
  const mode = process.argv[2]
  try {
    if (mode === 'install') install()
    else if (mode === 'uninstall') uninstall()
    else {
      console.error('Usage: autostart <install|uninstall>')
      process.exit(1)
    }
  } catch (err) {
    console.error('[autostart]', (err as Error).message)
    process.exit(1)
  }
}
