export function getMqttBrokerUrl(): string {
    return process.env.MQTT_BROKER_URL || 'mqtts://a1vw7p0stdnykd-ats.iot.eu-west-1.amazonaws.com:8883';
}
