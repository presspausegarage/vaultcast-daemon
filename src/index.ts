// CLI entrypoint — runs the daemon in the foreground with terminal output.
// For the tray-app variant (GUI, background, autostart-friendly), see tray.ts.

import { startDaemon } from './daemon'

async function main() {
  console.log('\n  VaultCast Daemon starting...\n')

  const daemon = await startDaemon({ silent: false })

  // CLI mode: SIGINT / SIGTERM drive the shutdown.
  // The tray wrapper has its own "Quit" menu item and doesn't install these.
  const shutdown = async (signal: string) => {
    console.log(`\n[daemon] Received ${signal}, shutting down...`)
    await daemon.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[daemon] Fatal error:', err)
  process.exit(1)
})
