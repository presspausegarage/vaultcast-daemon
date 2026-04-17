// Tray-app entrypoint — drives the same daemon bootstrap from a system tray
// icon instead of a terminal. Menu is intentionally small: status, adapter,
// vault, pair, open folder, open config, quit. Everything else lives in
// config.toml — the tray is for operating the daemon, not configuring it.

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import SysTray from 'systray2'
import { startDaemon, type DaemonHandle } from './daemon'

// ─── Icon loading ─────────────────────────────────────────────────────────────

/**
 * systray2 wants the icon as base64 and the format is platform-specific:
 *   - Windows: .ico. Windows's shell_NotifyIcon API only accepts HICON handles,
 *     and systray2's Win32 binary decodes an .ico blob — a PNG shows up as the
 *     fallback asterisk glyph. The .ico we ship embeds 16/32/48/256 so Windows
 *     picks the right size for the DPI.
 *   - macOS: black silhouette PNG with alpha (tray-icon-template.png). Paired
 *     with `isTemplateIcon: true` below, macOS auto-inverts to white on dark
 *     menu bars and keeps it black on light menu bars. The file MUST be
 *     black+alpha for template behavior to work per Apple HIG.
 *   - Linux: white silhouette PNG (tray-icon-light.png). Most Linux panels
 *     use dark backgrounds; a white glyph reads cleanly.
 *
 * The bulb shape itself matches the mobile app's CaptureIcon so the whole
 * product has one visual identity — the same silhouette the user taps on
 * their phone is what they look for in their system tray.
 *
 * Falls back to the legacy `tray-icon.png` name if the platform-specific file
 * is missing, then to no icon (systray2 shows its own placeholder).
 */
function loadIconBase64(): string {
  const assetsDir = path.join(__dirname, '..', 'assets')

  let primary: string
  if (process.platform === 'win32') primary = 'tray-icon.ico'
  else if (process.platform === 'darwin') primary = 'tray-icon-template.png'
  else primary = 'tray-icon-light.png'

  for (const name of [primary, 'tray-icon.png']) {
    const iconPath = path.join(assetsDir, name)
    try {
      return fs.readFileSync(iconPath).toString('base64')
    } catch {
      // try next fallback
    }
  }

  console.warn(`[tray] No tray icon found in ${assetsDir} — using system default.`)
  return ''
}

// ─── Platform open helpers ────────────────────────────────────────────────────

/**
 * Shell out to the native "open this path/URL in the default handler".
 * We use the OS helpers rather than a library so we don't pull in a heavy
 * dep for three lines of code.
 */
function openInOS(target: string): void {
  const platform = process.platform
  let cmd: string
  let args: string[]

  if (platform === 'win32') {
    // Using `cmd /c start` ensures the URL/path is handed to the Windows
    // shell which resolves the registered default handler (browser / file
    // explorer / notepad). The empty "" is the window title — required when
    // the target is a quoted path so `start` doesn't misinterpret it as one.
    cmd = 'cmd'
    args = ['/c', 'start', '""', target]
  } else if (platform === 'darwin') {
    cmd = 'open'
    args = [target]
  } else {
    cmd = 'xdg-open'
    args = [target]
  }

  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

// ─── Tray bootstrap ───────────────────────────────────────────────────────────

async function main() {
  console.log('\n  VaultCast Daemon (tray) starting...\n')

  const daemon: DaemonHandle = await startDaemon({ silent: true })
  const pairUrl = `http://127.0.0.1:${daemon.port}/pair`
  const configPath = path.join(os.homedir(), '.vaultcast', 'config.toml')

  // Menu item IDs must be unique strings — we key on these in the click handler.
  // systray2 uses title text as fallback but IDs give us rename-safety.
  type MenuId = 'status' | 'adapter' | 'vault' | 'pair' | 'open-vault' | 'open-config' | 'quit'

  const menuItems = [
    {
      title: 'VaultCast Daemon — running',
      tooltip: 'Click to show pairing QR',
      checked: false,
      enabled: false,
    },
    {
      title: `Adapter: ${daemon.adapter.name}`,
      tooltip: daemon.config.adapter.vaultPath,
      checked: false,
      enabled: false,
    },
    {
      title: `IP: ${daemon.advertisedIP}:${daemon.port}`,
      tooltip: 'Advertised LAN address — edit daemon.host in config.toml to override',
      checked: false,
      enabled: false,
    },
    SysTray.separator,
    {
      title: 'Show pairing QR',
      tooltip: 'Open the pairing page in your default browser',
      checked: false,
      enabled: true,
    },
    {
      title: 'Open vault folder',
      tooltip: daemon.config.adapter.vaultPath,
      checked: false,
      enabled: true,
    },
    {
      title: 'Open config file',
      tooltip: configPath,
      checked: false,
      enabled: true,
    },
    SysTray.separator,
    {
      title: 'Quit',
      tooltip: 'Stop the daemon and exit',
      checked: false,
      enabled: true,
    },
  ]

  const iconB64 = loadIconBase64()
  const systray = new SysTray({
    menu: {
      // systray2 expects an icon for macOS; on Windows a missing icon falls
      // back to a generic placeholder. We pass base64 either way.
      icon: iconB64,
      isTemplateIcon: process.platform === 'darwin', // macOS auto-inverts for dark mode
      title: 'VaultCast',
      tooltip: 'VaultCast Daemon',
      items: menuItems,
    },
    debug: false,
    copyDir: true, // extract native tray binary to OS temp dir so it survives pkg/exe bundling
  })

  // Click handler — we index into the menuItems array by the title string so
  // renaming a label in one place doesn't silently break the dispatch.
  systray.onClick((action) => {
    const title = action.item.title
    switch (title) {
      case 'Show pairing QR':
        openInOS(pairUrl)
        break
      case 'Open vault folder':
        openInOS(daemon.config.adapter.vaultPath)
        break
      case 'Open config file':
        openInOS(configPath)
        break
      case 'Quit':
        shutdown('tray-quit').catch((e) => {
          console.error('[tray] Error during shutdown:', e)
          process.exit(1)
        })
        break
    }
  })

  async function shutdown(reason: string) {
    console.log(`[tray] Shutting down (${reason})...`)
    try {
      systray.kill(false)
    } catch (err) {
      console.warn('[tray] Failed to kill tray process:', err)
    }
    await daemon.stop()
    process.exit(0)
  }

  // SIGINT/SIGTERM still work (e.g. launchd sending SIGTERM on logout) — we
  // want the same clean-shutdown path as the Quit menu item.
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  console.log(`[tray] Ready. Pair at ${pairUrl}`)
}

main().catch((err) => {
  console.error('[tray] Fatal error:', err)
  process.exit(1)
})
