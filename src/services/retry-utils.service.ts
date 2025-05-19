import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class RetryUtilsService {
  private readonly logger = new Logger(RetryUtilsService.name);

  /**
   * Execute a function with exponential backoff retry logic
   * @param operation Function to execute and retry if it fails
   * @param retryCondition Optional function to determine if retry should happen based on error
   * @param options Retry configuration options
   * @returns The result of the operation
   */
  async withExponentialBackoff<T>(
    operation: () => Promise<T>,
    retryCondition: (error: any) => boolean = () => true,
    options: {
      initialDelayMs?: number;
      maxDelayMs?: number;
      maxRetries?: number;
      backoffFactor?: number;
      jitterFactor?: number;
      operationName?: string;
    } = {}
  ): Promise<T> {
    const {
      initialDelayMs = 1000,
      maxDelayMs = 60000,
      maxRetries = 5,
      backoffFactor = 2,
      jitterFactor = 0.2,
      operationName = 'operation'
    } = options;

    let retryCount = 0;
    let delay = initialDelayMs;

    while (true) {
      try {
        return await operation();
      } catch (error) {
        // Check if we should retry based on the error
        if (!retryCondition(error)) {
          this.logger.error(`${operationName} failed with non-retryable error: ${error.message}`);
          throw error;
        }

        retryCount++;
        if (retryCount > maxRetries) {
          this.logger.error(`${operationName} failed after ${maxRetries} retries: ${error.message}`);
          throw error;
        }

        // Add jitter to the delay to prevent thundering herd problem
        const jitter = 1 - jitterFactor + (Math.random() * jitterFactor * 2);
        const actualDelay = Math.min(delay * jitter, maxDelayMs);

        this.logger.warn(
          `${operationName} failed (attempt ${retryCount}/${maxRetries}), retrying in ${Math.round(actualDelay)}ms: ${error.message}`
        );

        await new Promise(resolve => setTimeout(resolve, actualDelay));
        
        // Increase the delay for the next retry
        delay = Math.min(delay * backoffFactor, maxDelayMs);
      }
    }
  }

  /**
   * Check if an error is a Google API rate limit or server error
   * @param error The error to check
   * @returns True if the error is retryable
   */
  isGoogleApiRetryableError(error: any): boolean {
    if (!error) return false;

    // Prevent recursion if error is a circular structure
    try {
      // Just attempt to stringify part of the error to check for circular references
      JSON.stringify(error.message || error.code || '');
    } catch (e) {
      this.logger.error('Error appears to contain circular references, not retrying');
      return false;
    }

    // Maximum error size check - if the error is too large, don't retry
    // This can prevent problems with very large error responses
    const errorString = JSON.stringify(error).length;
    if (errorString > 10000) {
      this.logger.error(`Error object is too large (${errorString} chars), not retrying`);
      return false;
    }

    // Check for stack overflow type errors - these should not be retried
    if (error.message && 
        (error.message.includes('Maximum call stack size exceeded') || 
         error.message.includes('stack overflow'))) {
      this.logger.error('Stack overflow detected, not retrying');
      return false;
    }

    // Check for rate limiting status codes
    const statusCode = error.code || (error.response && error.response.status);
    
    // Common retryable status codes:
    // 429: Too Many Requests (rate limiting)
    // 500, 502, 503, 504: Server errors
    // 403: Forbidden (can be rate limiting for some Google APIs)
    const retryableStatusCodes = [403, 429, 500, 502, 503, 504];
    
    if (retryableStatusCodes.includes(Number(statusCode))) {
      return true;
    }

    // Check error message for common retryable errors
    const errorMessage = error.message || '';
    const retryableErrorMessages = [
      'rate limit',
      'quota exceeded',
      'too many requests',
      'internal server error',
      'backend error',
      'timeout',
      'service unavailable',
      'temporarily unavailable',
      'connection reset',
      'connection closed',
      'socket hang up'
    ];

    return retryableErrorMessages.some(msg => 
      errorMessage.toLowerCase().includes(msg.toLowerCase())
    );
  }
} 