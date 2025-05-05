
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 8; // Increased threshold
    this.resetTimeout = options.resetTimeout || 120000; // 2 minute cooldown
    this.cooldownPeriod = options.cooldownPeriod || 180000; // 3 minute cooldown period
    this.successThreshold = options.successThreshold || 2; // Requires 2 successes to close
    this.monitors = new Map();
  }

  getMonitor(key) {
    if (!this.monitors.has(key)) {
      this.monitors.set(key, {
        failures: 0,
        successes: 0,
        lastFailure: null,
        lastSuccess: null,
        status: 'CLOSED',
        cooldownStart: null
      });
    }
    return this.monitors.get(key);
  }

  async execute(key, operation) {
    const monitor = this.getMonitor(key);
    
    if (monitor.status === 'OPEN') {
      if (Date.now() - monitor.lastFailure >= this.resetTimeout) {
        console.log(`Circuit ${key} entering half-open state`);
        monitor.status = 'HALF_OPEN';
        monitor.successes = 0;
      } else {
        throw new Error(`Circuit breaker is OPEN for ${key} (${Math.round((this.resetTimeout - (Date.now() - monitor.lastFailure))/1000)}s remaining)`);
      }
    }

    try {
      const result = await operation();
      monitor.lastSuccess = Date.now();
      monitor.successes++;
      
      if (monitor.status === 'HALF_OPEN') {
        if (monitor.successes >= this.successThreshold) {
          console.log(`Circuit ${key} closing after ${monitor.successes} successes`);
          monitor.status = 'CLOSED';
          monitor.failures = 0;
          monitor.cooldownStart = null;
        }
      } else {
        monitor.failures = Math.max(0, monitor.failures - 1); // Gradual failure reduction
      }
      
      return result;
    } catch (error) {
      monitor.failures++;
      monitor.lastFailure = Date.now();
      monitor.successes = 0;
      
      if (monitor.failures >= this.failureThreshold) {
        if (!monitor.cooldownStart || (Date.now() - monitor.cooldownStart >= this.cooldownPeriod)) {
          console.log(`Circuit ${key} opening after ${monitor.failures} failures`);
          monitor.status = 'OPEN';
          monitor.cooldownStart = Date.now();
        }
      }
      throw error;
    }
  }

  reset(key) {
    console.log(`Resetting circuit ${key}`);
    this.monitors.delete(key);
  }
}

module.exports = CircuitBreaker;
