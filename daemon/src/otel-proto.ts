import protobuf from "protobufjs";
import { otelProtoSchema } from "./otel-proto-schema.js";

const root = protobuf.Root.fromJSON(
  otelProtoSchema as unknown as protobuf.INamespace,
);
const requestType = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);
export type ProtoObject = Record<string, unknown>;
export function decodeOtlpTrace(bytes: Uint8Array): ProtoObject {
  return requestType.toObject(requestType.decode(bytes), {
    longs: String,
    bytes: Buffer,
    enums: String,
    defaults: false,
    arrays: true,
    objects: true,
    oneofs: true,
  }) as ProtoObject;
}
export function encodeOtlpTrace(value: ProtoObject): Uint8Array {
  const message = requestType.fromObject(value);
  const error = requestType.verify(message);
  if (error) throw new Error(error);
  return requestType.encode(message).finish();
}
export function otlpSpans(value: ProtoObject): ProtoObject[] {
  const result: ProtoObject[] = [];
  for (const resource of (value.resourceSpans as ProtoObject[] | undefined) ??
    [])
    for (const scope of (resource.scopeSpans as ProtoObject[] | undefined) ??
      [])
      for (const span of (scope.spans as ProtoObject[] | undefined) ?? [])
        result.push(span);
  return result;
}
export function attributeMap(span: ProtoObject): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const raw of (span.attributes as ProtoObject[] | undefined) ?? []) {
    if (typeof raw.key !== "string") continue;
    const value = raw.value as ProtoObject | undefined;
    if (!value) continue;
    for (const key of [
      "stringValue",
      "intValue",
      "boolValue",
      "doubleValue",
      "bytesValue",
    ])
      if (value[key] !== undefined) {
        result.set(raw.key, value[key]);
        break;
      }
  }
  return result;
}
export function setStringAttribute(
  span: ProtoObject,
  key: string,
  value: string,
): void {
  setAttribute(span, key, { stringValue: value });
}
export function setIntAttribute(
  span: ProtoObject,
  key: string,
  value: number,
): void {
  setAttribute(span, key, { intValue: String(Math.trunc(value)) });
}
export function setBoolAttribute(
  span: ProtoObject,
  key: string,
  value: boolean,
): void {
  setAttribute(span, key, { boolValue: value });
}
function setAttribute(
  span: ProtoObject,
  key: string,
  value: ProtoObject,
): void {
  const attributes = (span.attributes as ProtoObject[] | undefined) ?? [];
  const found = attributes.find((attribute) => attribute.key === key);
  if (found) found.value = value;
  else attributes.push({ key, value });
  span.attributes = attributes;
}
export function bytesHex(value: unknown): string | undefined {
  return Buffer.isBuffer(value)
    ? value.toString("hex")
    : value instanceof Uint8Array
      ? Buffer.from(value).toString("hex")
      : typeof value === "string"
        ? Buffer.from(value, "base64").toString("hex")
        : undefined;
}
