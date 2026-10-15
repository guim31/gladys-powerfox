// -----------------------------------------------------------------------------
// Deduplicated problem logging. A failure that repeats (powerfox unreachable,
// a rate limit, Gladys restarting) writes one line when it starts and one
// when it is over, not one per attempt: the attempts in between go to the
// debug level (LOG_LEVEL=debug shows them).
// -----------------------------------------------------------------------------

export class IssueLog {
  /** @param {object} logger an SDK logger (debug/info/warn/error) */
  constructor(logger) {
    this.logger = logger;
    /** @type {Set<string>} keys of the problems going on */
    this.open = new Set();
  }

  /**
   * A failure: logged at `level` the first time, at debug while it lasts.
   * @returns {boolean} true when it is a new problem
   */
  fail(key, message, level = 'warn') {
    if (this.open.has(key)) {
      this.logger.debug(message);
      return false;
    }
    this.open.add(key);
    this.logger[level](message);
    return true;
  }

  /**
   * A success: one info line if the problem was going on, nothing otherwise.
   * @returns {boolean} true when a problem is over
   */
  recover(key, message) {
    if (!this.open.delete(key)) {
      return false;
    }
    if (message) {
      this.logger.info(message);
    }
    return true;
  }

  has(key) {
    return this.open.has(key);
  }

  /** Forget every problem (a new configuration starts afresh). */
  clear() {
    this.open.clear();
  }
}
