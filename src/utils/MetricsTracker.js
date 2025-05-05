
class MetricsTracker {
  constructor() {
    this.metrics = new Map();
    this.resetInterval = setInterval(() => this.resetCounters(), 3600000);
  }

  track(category, event, metadata = {}) {
    const key = `${category}:${event}`;
    if (!this.metrics.has(key)) {
      this.metrics.set(key, {
        count: 0,
        failures: 0,
        success: 0,
        totalTime: 0,
        lastUpdate: Date.now()
      });
    }

    const metric = this.metrics.get(key);
    metric.count++;
    
    if (metadata.success) metric.success++;
    if (metadata.failure) metric.failures++;
    if (metadata.duration) metric.totalTime += metadata.duration;
    
    metric.lastUpdate = Date.now();
  }

  getMetrics(category) {
    const results = {};
    for (const [key, value] of this.metrics.entries()) {
      if (key.startsWith(category)) {
        results[key] = {...value};
      }
    }
    return results;
  }

  resetCounters() {
    for (const metric of this.metrics.values()) {
      metric.count = 0;
      metric.failures = 0;
      metric.success = 0;
      metric.totalTime = 0;
    }
  }

  cleanup() {
    clearInterval(this.resetInterval);
  }
}

module.exports = MetricsTracker;
