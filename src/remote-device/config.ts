export const MQTT_BROKER_URLS = {
    staging: 'mqtts://a1vw7p0stdnykd-ats.iot.eu-west-3.amazonaws.com:8883',
    // Production must not use staging credentials or infrastructure.
    production: null,
} as const;

/** Choose the broker from the same backend used for device authentication. */
export function getMqttBrokerUrl(serverUrl: string): string {
    const hostname = new URL(serverUrl).hostname;
    if (hostname === 'mcp.desktopcommander.app') {
        if (!MQTT_BROKER_URLS.production) throw new Error('Production MQTT broker URL is not configured');
        return MQTT_BROKER_URLS.production;
    }
    if (hostname === 'staging-mcp.desktopcommander.app') {
        return MQTT_BROKER_URLS.staging;
    }
    throw new Error('MQTT broker is not configured for this MCP backend');
}
