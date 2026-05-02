import { concatArrayBuffers, describeBody, decodeText } from "../shared/body-decoder.js";
import { BODY_KIND } from "../shared/constants.js";

export class BoundedStreamSink {
  constructor({ maxBytes }) {
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.totalBytes = 0;
    this.capturedBytes = 0;
    this.truncated = false;
  }

  append(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    this.totalBytes += bytes.byteLength;

    const remaining = this.maxBytes - this.capturedBytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }

    if (bytes.byteLength > remaining) {
      this.chunks.push(bytes.slice(0, remaining));
      this.capturedBytes += remaining;
      this.truncated = true;
      return;
    }

    this.chunks.push(bytes.slice());
    this.capturedBytes += bytes.byteLength;
  }

  snapshot() {
    const { bytes } = concatArrayBuffers(this.chunks, this.maxBytes);
    return {
      bytes,
      totalBytes: this.totalBytes,
      truncated: this.truncated
    };
  }
}

export function attachResponseFilter({ requestId, maxBytes, responseHeaders, onStop, onError }) {
  const filter = browser.webRequest.filterResponseData(requestId);
  const sink = new BoundedStreamSink({ maxBytes });

  filter.ondata = (event) => {
    filter.write(event.data);
    sink.append(event.data);
  };

  filter.onstop = () => {
    const snapshot = sink.snapshot();
    try {
      filter.close();
    } finally {
      onStop(snapshot);
    }
  };

  filter.onerror = () => {
    try {
      filter.disconnect();
    } catch {
      // Best-effort cleanup only. Do not throw from filter error handling.
    } finally {
      onError(filter.error || "unknown stream error");
    }
  };

  return filter;
}

export async function buildResponsePayload({ captureId, snapshot, headers, maxPreviewChars }) {
  const bodyRef = await describeBody({
    bytes: snapshot.bytes,
    totalBytes: snapshot.totalBytes,
    truncated: snapshot.truncated,
    headers,
    maxPreviewChars
  });

  const storageKey = `payload:${captureId}:response`;
  bodyRef.storageKey = storageKey;

  const payload = {
    id: storageKey,
    captureId,
    role: "response",
    kind: bodyRef.kind,
    byteLength: bodyRef.byteLength,
    capturedByteLength: bodyRef.capturedByteLength,
    truncated: bodyRef.truncated,
    sha256: bodyRef.sha256
  };

  if (bodyRef.kind !== BODY_KIND.BINARY && bodyRef.contentEncoding === undefined) {
    payload.text = decodeText(snapshot.bytes, bodyRef.charset || "utf-8");
  } else {
    payload.bytes = snapshot.bytes.buffer;
  }

  return { bodyRef, payload };
}
