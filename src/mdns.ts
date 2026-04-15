import { Bonjour, Service } from 'bonjour-service'

const SERVICE_TYPE = 'vaultcast'
const SERVICE_NAME = 'VaultCast Daemon'

let bonjour: Bonjour | null = null
let service: Service | null = null

/**
 * Register the daemon on the local network via mDNS/Bonjour.
 * The mobile app discovers the daemon by looking for _vaultcast._tcp services —
 * it gets the IP and port automatically without any manual configuration.
 */
export function registerMDNS(port: number): void {
  bonjour = new Bonjour()

  service = bonjour.publish({
    name: SERVICE_NAME,
    type: SERVICE_TYPE,
    port,
    txt: { version: '0.1.0' },
  })

  service.on('up', () => {
    console.log(`[mdns] Service registered — broadcasting as "${SERVICE_NAME}" on port ${port}`)
  })

  service.on('error', (err: Error) => {
    console.error('[mdns] Service registration error:', err.message)
  })
}

/**
 * Gracefully stop the mDNS service and destroy the Bonjour instance.
 * Called during daemon shutdown so the service disappears from the network promptly.
 */
export function unregisterMDNS(): Promise<void> {
  return new Promise((resolve) => {
    if (!service || !bonjour) {
      resolve()
      return
    }

    service.stop?.(() => {
      bonjour!.destroy()
      console.log('[mdns] Service unregistered.')
      resolve()
    }) ?? resolve()
  })
}
