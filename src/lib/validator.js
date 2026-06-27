/**
 * Validates a provider route by making a test request to the upstream endpoint.
 * Checks reachability, HTTP status, and JSON response validity.
 *
 * @param {Object} params
 * @param {string} params.upstreamUrl - The provider endpoint URL (must be HTTPS)
 * @param {string} params.httpMethod - The HTTP method to use for the test call
 * @param {number} [params.timeoutMs] - Timeout in milliseconds (capped at 15,000ms)
 * @param {any} [params.testPayload] - Optional body payload for POST/PUT/PATCH tests
 * @returns {Promise<{passed: boolean, latencyMs: number|null, error: string|null}>}
 * Never throws — always returns a result object.
 */
export async function validateRoute({ upstreamUrl, httpMethod, timeoutMs, testPayload }) {
  // Validate upstreamUrl
  if (!upstreamUrl || typeof upstreamUrl !== 'string') {
    return { passed: false, latencyMs: null, error: 'upstreamUrl is required' }
  }

  let url
  try {
    url = new URL(upstreamUrl)
  } catch {
    return { passed: false, latencyMs: null, error: 'upstreamUrl is not a valid URL' }
  }

  if (url.protocol !== 'https:') {
    return { passed: false, latencyMs: null, error: 'upstreamUrl must use HTTPS' }
  }

  // Validate and normalize HTTP method
  const validMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
  const method = (httpMethod || 'POST').toUpperCase()
  if (!validMethods.includes(method)) {
    return { passed: false, latencyMs: null, error: `Invalid HTTP method: ${httpMethod}` }
  }

  // Cap validation timeout at 15 seconds (don't hammer providers during validation)
  const timeout = Math.min(timeoutMs ?? 8000, 15_000)

  try {
    const signal = AbortSignal.timeout(timeout)
    const start = Date.now()

    const res = await fetch(upstreamUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Validation': 'true'
      },
      body: method === 'GET' || method === 'HEAD'
        ? undefined
        : JSON.stringify(testPayload ?? {}),
      signal
    })

    const latencyMs = Date.now() - start

    // Upstream returned non-2xx status
    if (!res.ok) {
      return {
        passed: false,
        latencyMs,
        error: `Upstream returned HTTP ${res.status}`
      }
    }

    // Validate response is valid JSON
    try {
      await res.json()
    } catch {
      return {
        passed: false,
        latencyMs,
        error: 'Upstream did not return valid JSON'
      }
    }

    return { passed: true, latencyMs, error: null }

  } catch (err) {
    // Network error, DNS failure, or timeout
    return {
      passed: false,
      latencyMs: null,
      error: err.message || 'Unknown validation error'
    }
  }
}
