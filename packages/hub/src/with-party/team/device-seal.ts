import { NoydbError } from '../../kernel/errors.js'
import {
  generateEphemeralKey, encryptBytes, decryptBytes, bufferToBase64, base64ToBuffer, type EnclaveKey,
} from '../../kernel/enclave/index.js'
import type { NoydbDeviceSeal } from '../../port/with/device-seal-strategy.js'

/**
 * Device-local sealer for the echo reveal-blob (spec decision 5).
 * DISTINCT from `NoydbSealer` (managed-secret mode, which seals
 * the WHOLE secret): this seals only the echo part, and only so an
 * enrolled device can display it during the unlock ceremony. The
 * sealed bytes may sit in the (untrusted) keyring file — attacker-B
 * resistance comes from `unseal` requiring this device's key store.
 *
 * The interface itself is declared on the `/with` port
 * ({@link NoydbDeviceSeal} from `port/with/device-seal-strategy.js`)
 * so the kernel spine can reference it without a static spine→service
 * import; re-exported here as the canonical consumer-facing home.
 */
export type { NoydbDeviceSeal }

/** In-memory test provider — AES-GCM under a per-instance random key. */
export class MemoryDeviceSeal implements NoydbDeviceSeal {
  readonly id: string
  private readonly keyPromise: Promise<EnclaveKey>
  constructor(opts: { id: string }) {
    this.id = opts.id
    this.keyPromise = generateEphemeralKey()
  }
  async seal(plain: Uint8Array): Promise<Uint8Array> {
    const { iv, data } = await encryptBytes(plain, await this.keyPromise)
    const ivB = base64ToBuffer(iv)
    const ct = base64ToBuffer(data)
    const out = new Uint8Array(ivB.byteLength + ct.byteLength)
    out.set(ivB, 0)
    out.set(ct, ivB.byteLength)
    return out
  }
  async unseal(sealed: Uint8Array): Promise<Uint8Array> {
    try {
      return await decryptBytes(
        bufferToBase64(sealed.slice(0, 12)),
        bufferToBase64(sealed.slice(12)),
        await this.keyPromise,
      )
    } catch {
      throw new NoydbError('DEVICE_SEAL_UNSEAL_FAILED', 'Device seal: unseal failed (tamper or wrong device).')
    }
  }
}
