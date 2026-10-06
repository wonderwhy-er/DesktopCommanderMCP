const REQUIRED = ["call_id", "stage", "timestamp_utc"];
const OPTIONAL = [
    "monotonic_ms",
    "transport",
    "notification_id",
    "attempt_number",
    "observation_id",
    "source_process_id",
    "schema_version",
    "outcome",
    "reason",
    "duration_ms",
    "retry_wait_ms",
    "arrival_gap_ms",
    "deadline_utc",
    "tool_call_received_utc",
    "tool_call_received_monotonic_ms",
    "duplicate_count",
    "dropped_count",
    "source",
    "device_id",
    "environment",
    "operation",
    "operation_id",
    "operation_attempt",
    "result_source",
    "tool_name",
];

function isTimestamp(value) {
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
    return typeof value === "string" && iso.test(value) && !Number.isNaN(Date.parse(value));
}

function validProperty(key, value) {
    switch (key) {
        case "source_process_id":
        case "device_id":
        case "call_id":
        case "notification_id":
        case "observation_id":
        case "operation_id":
            return typeof value === "string" && value.length > 0;
        case "transport":
            return value === "mqtt" || value === "broadcast";
        case "stage":
        case "outcome":
        case "reason":
        case "operation":
        case "environment":
            return typeof value === "string" && value.length > 0;
        case "tool_name":
            return typeof value === "string";
        case "result_source":
            return value === "doorbell" || value === "recovery";
        case "operation_attempt":
        case "schema_version":
            return Number.isSafeInteger(value) && value >= 1;
        case "source":
            return value === "server" || value === "device";
        case "attempt_number":
        case "duplicate_count":
        case "dropped_count":
            return Number.isSafeInteger(value) && value >= 0;
        case "timestamp_utc":
        case "deadline_utc":
        case "tool_call_received_utc":
            return isTimestamp(value);
        default:
            return (
                typeof value === "number" &&
                Number.isFinite(value) &&
                Math.abs(value) <= Number.MAX_SAFE_INTEGER &&
                (key === "arrival_gap_ms" || value >= 0)
            );
    }
}

export function hasTransportEvents(payload) {
    return (
        Array.isArray(payload?.events) &&
        payload.events.some((event) => {
            const params = event?.params;
            const transport = params?.transport;
            return (
                event?.name === "mqtt" ||
                event?.name === "broadcast" ||
                (["mqtt", "broadcast"].includes(transport) && (params?.call_id !== undefined || params?.stage !== undefined)) ||
                (params?.call_id !== undefined && event?.name === params?.stage)
            );
        })
    );
}

export function sanitizeTransportEvent(eventName, rawParams) {
    if (
        !rawParams ||
        typeof rawParams !== "object" ||
        Array.isArray(rawParams) ||
        (eventName !== rawParams.stage && eventName !== rawParams.transport)
    ) {
        throw new Error("Invalid transport event");
    }
    const params = {};
    for (const key of REQUIRED) {
        if (!Object.hasOwn(rawParams, key) || !validProperty(key, rawParams[key])) {
            throw new Error("Invalid transport event property");
        }
        params[key] = key.endsWith("_utc") ? new Date(rawParams[key]).toISOString() : rawParams[key];
    }
    for (const key of OPTIONAL) {
        if (!Object.hasOwn(rawParams, key) || !validProperty(key, rawParams[key])) {
            continue;
        }
        params[key] = key.endsWith("_utc") ? new Date(rawParams[key]).toISOString() : rawParams[key];
    }
    return params;
}

function parseTransportPayload(payload, isServer) {
    if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        !Array.isArray(payload.events) ||
        payload.events.length < 1 ||
        payload.events.length > 10
    ) {
        throw new Error("Invalid events");
    }
    const userId = typeof payload.user_id === "string" ? payload.user_id.trim() : "";
    if (isServer && (!userId || userId.length > 128)) {
        throw new Error("Invalid user_id");
    }
    if (!isServer && (typeof payload.client_id !== "string" || !payload.client_id)) {
        throw new Error("Invalid client_id");
    }
    const events = payload.events.map((event) => {
        if (!event || typeof event !== "object" || Array.isArray(event)) {
            throw new Error("Invalid event");
        }
        const raw = event.params;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error("Invalid params");
        }
        const params = sanitizeTransportEvent(event.name, isServer ? raw : { ...raw, source: "device" });
        if (!isServer && !params.device_id) {
            throw new Error("Missing device_id");
        }
        return { name: params.stage, params };
    });
    if (isServer) {
        return { user_id: userId, events };
    }
    return { client_id: payload.client_id, events };
}

export function parseRemoteTransportPayload(payload) {
    return parseTransportPayload(payload, true);
}

export function parseDeviceTransportPayload(payload) {
    return parseTransportPayload(payload, false);
}
