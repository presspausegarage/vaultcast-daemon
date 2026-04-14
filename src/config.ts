import fs from 'fs'
import path from 'path'
import os from 'os'
import TOML from '@iarna/toml'
import type { DaemonConfig } from './types'

const CONFIG_DIR = path.join(os.homedir(), '.vaultcast')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.toml')

const DEFAULTS: DaemonConfig = {
  daemon: {
    port: 47821,
    logLevel: 'info',
  },
  adapter: {
    type: 'folder',
    vaultPath: path.join(os.homedir(), 'VaultCast-Inbox'),
    fallbackPath: path.join(os.homedir(), 'VaultCast-Inbox'),
  },
}

// ─── Load ─────────────────────────────────────────────────────────────────────

export function loadConfig(): DaemonConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`[config] No config found — writing defaults to ${CONFIG_PATH}`)
    saveConfig(DEFAULTS)
    return DEFAULTS
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
  const parsed = TOML.parse(raw) as unknown as DaemonConfig

  // Merge with defaults so missing keys don't throw at runtime
  return {
    daemon: { ...DEFAULTS.daemon, ...parsed.daemon },
    adapter: { ...DEFAULTS.adapter, ...parsed.adapter },
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────────

export function saveConfig(config: DaemonConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
  fs.writeFileSync(CONFIG_PATH, TOML.stringify(config as unknown as TOML.JsonMap))
}

// ─── Ensure vault folders exist ───────────────────────────────────────────────

export function ensureFolders(config: DaemonConfig): void {
  const { vaultPath, fallbackPath } = config.adapter

  for (const folder of [vaultPath, fallbackPath]) {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true })
      console.log(`[config] Created folder: ${folder}`)
    }
  }
}
