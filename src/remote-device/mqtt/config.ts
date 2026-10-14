export const IS_MQTT_RESULT_PAYLOAD_ENABLED = process.env.IS_MQTT_RESULT_PAYLOAD_ENABLED === 'true';
export const IS_MQTT_EXECUTION_ENABLED = process.env.IS_MQTT_EXECUTION_ENABLED === 'true';

export function getMqttBrokerUrl(): string {
    return process.env.MQTT_BROKER_URL || 'mqtts://a1vw7p0stdnykd-ats.iot.eu-west-1.amazonaws.com:8883';
}
