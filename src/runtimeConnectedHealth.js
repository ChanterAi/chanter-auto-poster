/**
 * @typedef {object} ConnectedHealthParams
 * @property {import('firebase/firestore').Firestore}
 *   getFirestore - Firestore instance.
 * @property {boolean} configured - Whether the service is configured.
 * @property {string | null} emulatorHost - Host for local emulator (e.g., 'localhost:8080').
 * @property {number} timeoutMs - Timeout duration in milliseconds.
 */

/**
 * Reads the connected health status of Firestore.
 * 
 * @param {ConnectedHealthParams} params
 * @returns {Promise<{ok: boolean, storage: {provider: 'firestore', mode: string, reachable: (boolean|null)}, observedAt: string}>}
 */
async function readConnectedHealth({ getFirestore, configured, emulatorHost, timeoutMs }) {
  const observedAt = new Date().toISOString();

  // 1. If configured === false -> return mode 'unknown', reachable null, ok false, and DO NOT call getFirestore at all.
  if (configured === false) {
    return {
      ok: false,
      storage: { provider: 'firestore', mode: 'unknown', reachable: null },
      observedAt: observedAt,
    };
  }

  // 2. Otherwise candidate mode = emulatorHost ? 'emulator' : 'real'.
  const candidateMode = emulatorHost ? 'emulator' : 'real';

  let timer; // Declare timer variable to ensure cleanup in all paths
  try {
    // Set up the timeout mechanism
    const readPromise = (async () => {
      const db = getFirestore();
      // 3. Perform ONE cheap bounded read: getFirestore().collection('config').doc('evo-health-probe').get()
      return db.collection('config').doc('evo-health-probe').get();
    })();

    // Race the read against a timer
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
    });

    const result = await Promise.race([readPromise, timeoutPromise]);

    // Read resolved first -> reachable true, mode = candidate, ok true.
    return {
      ok: true,
      storage: { provider: 'firestore', mode: candidateMode, reachable: true },
      observedAt: observedAt,
    };
  } catch (error) {
    // 4. Clear the timer in all paths. NEVER throw.
    if (timer) {
      clearTimeout(timer);
    }

    // Read rejected OR the timer won -> mode 'unavailable', reachable false, ok false.
    return {
      ok: false,
      storage: { provider: 'firestore', mode: 'unavailable', reachable: false },
      observedAt: observedAt,
    };
  } finally {
    // Ensure cleanup even if an unexpected error occurs before the timer is set/cleared.
    if (timer) {
        clearTimeout(timer);
    }
  }
}

module.exports = { readConnectedHealth: readConnectedHealth };
