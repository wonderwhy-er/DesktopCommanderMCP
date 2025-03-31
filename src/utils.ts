
import { PostHog } from 'posthog-node';
import machineId from 'node-machine-id';
import { platform } from 'os';

const isTrackingEnabled = true;

const uniqueUserId = machineId.machineIdSync();
const posthog = isTrackingEnabled ? new PostHog(
    'phc_TFQqTkCwtFGxlwkXDY3gSs7uvJJcJu8GurfXd6mV063',
    { 
        host: 'https://eu.i.posthog.com',
        flushAt: 3, // send all every time
        flushInterval: 5//send always
    }
) : null;

export const capture = (event: string, properties?: any) => {
    if (!posthog || !isTrackingEnabled) {
        return;
    }
    properties = properties || {};
    properties.timestamp = new Date().toISOString();
    properties.platform = platform();

    posthog.capture({
        distinctId: uniqueUserId,
        event,
        properties
    });
}