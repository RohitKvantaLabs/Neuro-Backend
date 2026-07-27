/**
 * Lightweight in-process circuit breaker for external dependencies.
 *
 * Usage
 * -----
 *   const cb = new CircuitBreaker('python-agents', { failureThreshold: 5, recoveryTimeoutMs: 30000 });
 *
 *   // Wrap a function
 *   const safeCall = cb.wrap(async () => { return await axios.post(...) });
 *   const result = await safeCall();
 *
 * When the circuit is OPEN, the wrapped function throws CircuitBreakerOpenError
 * immediately — no attempt is made to call the dependency. After recoveryTimeoutMs
 * the circuit transitions to HALF_OPEN and lets one request through as a probe.
 */

class CircuitBreakerOpenError extends Error {
  constructor(name, retryAfterMs) {
    super(`Circuit breaker '${name}' is OPEN — retry in ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'CircuitBreakerOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

const STATES = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
};

class CircuitBreaker {
  /**
   * @param {string} name            Human-readable name for logging
   * @param {object} [opts]
   * @param {number} [opts.failureThreshold=5]      Consecutive failures before opening
   * @param {number} [opts.recoveryTimeoutMs=30000]  Time (ms) before HALF_OPEN probe
   */
  constructor(name, opts = {}) {
    this.name = name;
    this._failureThreshold = opts.failureThreshold || 5;
    this._recoveryTimeoutMs = opts.recoveryTimeoutMs || 30_000;

    this._state = STATES.CLOSED;
    this._failureCount = 0;
    this._lastFailureTime = null;
    this._halfOpenLock = false;
  }

  /** @returns {string} Current state (may auto-transition OPEN → HALF_OPEN) */
  get state() {
    if (this._state === STATES.OPEN && this._isRecoveryDue()) {
      this._log('transition', `OPEN → HALF_OPEN (recovery timeout elapsed)`);
      this._state = STATES.HALF_OPEN;
    }
    return this._state;
  }

  /** @returns {number} */
  get failureCount() {
    return this._failureCount;
  }

  /**
   * Wrap an async function with circuit breaker protection.
   * @template T
   * @param {(...args: any[]) => Promise<T>} fn
   * @returns {(...args: any[]) => Promise<T>}
   */
  wrap(fn) {
    const self = this;
    return async function wrapped(...args) {
      self._check();
      try {
        const result = await fn.apply(this, args);
        self._onSuccess();
        return result;
      } catch (err) {
        self._onFailure();
        throw err;
      }
    };
  }

  /**
   * Wrap a synchronous function with circuit breaker protection.
   * @template T
   * @param {(...args: any[]) => T} fn
   * @returns {(...args: any[]) => T}
   */
  wrapSync(fn) {
    const self = this;
    return function wrapped(...args) {
      self._check();
      try {
        const result = fn.apply(this, args);
        self._onSuccess();
        return result;
      } catch (err) {
        self._onFailure();
        throw err;
      }
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────

  _check() {
    const st = this.state; // may trigger OPEN → HALF_OPEN
    if (st === STATES.OPEN) {
      throw new CircuitBreakerOpenError(this.name, this._recoveryTimeoutMs);
    }
    if (st === STATES.HALF_OPEN) {
      if (this._halfOpenLock) {
        throw new CircuitBreakerOpenError(this.name, this._recoveryTimeoutMs);
      }
      this._halfOpenLock = true; // acquire probe lock
    }
  }

  _onSuccess() {
    if (this._state === STATES.HALF_OPEN) {
      this._log('recovery', 'HALF_OPEN → CLOSED');
      this._state = STATES.CLOSED;
      this._halfOpenLock = false;
    }
    this._failureCount = 0;
  }

  _onFailure() {
    this._failureCount += 1;
    this._lastFailureTime = Date.now();
    if (this._state === STATES.HALF_OPEN) {
      this._log('warning', `Probe failed — HALF_OPEN → OPEN`);
      this._state = STATES.OPEN;
      this._halfOpenLock = false;
    } else if (this._failureCount >= this._failureThreshold) {
      this._log('warning', `OPENED (${this._failureCount} failures)`);
      this._state = STATES.OPEN;
    }
  }

  _isRecoveryDue() {
    if (this._lastFailureTime === null) return true;
    return Date.now() - this._lastFailureTime >= this._recoveryTimeoutMs;
  }

  _log(level, msg) {
    // Use console.log since logger is not available in all contexts
    console.log(`[circuit-breaker:${this.name}] ${msg}`);
  }

  static CircuitBreakerOpenError = CircuitBreakerOpenError;
}

module.exports = { CircuitBreaker, CircuitBreakerOpenError };
