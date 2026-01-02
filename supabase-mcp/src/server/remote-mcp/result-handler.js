import { dispatchLogger } from '../../utils/logger.js';

/**
 * Result Handler Module
 * Manages pending tool call promises and result/error handling
 */

export class ResultHandler {
    constructor() {
        this.pendingCalls = new Map(); // callId -> { resolve, reject, userId, created }
    }

    /**
     * Create a pending call that will be resolved when result arrives
     * @param {string} callId - The unique call ID
     * @param {string} userId - The user ID
     * @param {number} timeout - Timeout in milliseconds
     * @returns {Promise} Promise that resolves with result or rejects with error
     */
    createPendingCall(callId, userId, timeout) {
        dispatchLogger.debug('Creating pending call', { callId, userId, timeoutMs: timeout });

        return new Promise((resolve, reject) => {
            this.pendingCalls.set(callId, {
                resolve,
                reject,
                userId,
                created: Date.now()
            });

            // Set timeout
            setTimeout(() => {
                if (this.pendingCalls.has(callId)) {
                    dispatchLogger.warn('Tool call timeout', { callId, userId, timeoutMs: timeout });
                    this.pendingCalls.delete(callId);
                    reject(new Error('Tool call timeout - agent did not respond'));
                }
            }, timeout);
        });
    }

    /**
     * Handle a successful result for a tool call
     * @param {string} callId - The call ID
     * @param {Object} result - The result data
     */
    handleResult(callId, result) {
        const pending = this.pendingCalls.get(callId);
        if (!pending) {
            // This is normal for restored sessions or duplicates, just ignore
            dispatchLogger.debug('Result received for non-pending call (likely duplicate)', { callId });
            return;
        }

        const duration = Date.now() - pending.created;
        dispatchLogger.info('Tool call completed successfully', {
            callId,
            userId: pending.userId,
            durationMs: duration
        });

        this.pendingCalls.delete(callId);
        pending.resolve(result);
    }

    /**
     * Handle an error for a tool call
     * @param {string} callId - The call ID
     * @param {string} errorMessage - The error message
     */
    handleError(callId, errorMessage) {
        const pending = this.pendingCalls.get(callId);
        if (!pending) {
            // This is normal for restored sessions or duplicates, just ignore
            dispatchLogger.debug('Error received for non-pending call (likely duplicate)', { callId });
            return;
        }

        const duration = Date.now() - pending.created;
        dispatchLogger.error('Tool call failed', {
            callId,
            userId: pending.userId,
            durationMs: duration,
            errorMessage
        });

        this.pendingCalls.delete(callId);
        pending.reject(new Error(errorMessage || 'Unknown error'));
    }

    /**
     * Check if a call is pending
     * @param {string} callId - The call ID
     * @returns {boolean} True if pending
     */
    isPending(callId) {
        return this.pendingCalls.has(callId);
    }

    /**
     * Clean up timed out calls
     * @param {number} timeout - Timeout threshold in milliseconds
     * @returns {number} Number of calls cleaned up
     */
    cleanupTimedOut(timeout) {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [callId, pending] of this.pendingCalls) {
            if (now - pending.created > timeout) {
                dispatchLogger.warn('Cleaning up timed out call', {
                    callId,
                    userId: pending.userId,
                    age: now - pending.created
                });
                this.pendingCalls.delete(callId);
                pending.reject(new Error('Tool call timeout'));
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            dispatchLogger.info('Cleanup completed', { cleanedCount });
        }

        return cleanedCount;
    }

    /**
     * Get count of pending calls
     * @returns {number} Number of pending calls
     */
    getPendingCount() {
        return this.pendingCalls.size;
    }
}
