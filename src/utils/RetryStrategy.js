
class RetryStrategy {
  constructor(options = {}) {
    this.baseDelay = options.baseDelay || 2000; // Increased base delay
    this.maxDelay = options.maxDelay || 30000;
    this.maxRetries = options.maxRetries || 5; // Increased retries
    this.jitterFactor = options.jitterFactor || 0.2; // Increased jitter
  }

  calculateDelay(attempt, errorType) {
    const baseDelay = errorType === 'complexity' ? 
      Math.min(this.baseDelay * 2 * attempt, this.maxDelay) :
      Math.min(Math.pow(2, attempt) * this.baseDelay, this.maxDelay);
    
    const jitter = baseDelay * this.jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, baseDelay + jitter);
  }

  async execute(operation, context = {}) {
    let attempt = 0;
    let lastError = null;

    while (attempt <= this.maxRetries) {
      try {
        const result = await operation();
        if (context.checkPublicUrl && (!result?.data?.assets?.[0]?.public_url)) {
          console.log(`Attempt ${attempt + 1}/${this.maxRetries}: Public URL undefined`);
          attempt++;
          if (attempt > this.maxRetries) {
            throw new Error('Max retries reached: Failed to get public URL');
          }
          const delay = this.calculateDelay(attempt, 'standard');
          console.log(`Waiting ${delay/1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return result;
      } catch (error) {
        lastError = error;
        attempt++;
        
        if (attempt > this.maxRetries) {
          console.error(`Max retries (${this.maxRetries}) reached:`, error.message);
          throw lastError;
        }
        
        const errorType = error.message.includes('Complexity budget') ? 'complexity' : 'standard';
        const delay = this.calculateDelay(attempt, errorType);
        
        console.log(`Retry attempt ${attempt}/${this.maxRetries} after ${delay}ms: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}

module.exports = RetryStrategy;
