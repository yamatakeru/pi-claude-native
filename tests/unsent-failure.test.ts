/**
 * Unsent failures (#99): a transient connection error before any request
 * bytes reached upstream ends with a note Pi's own retry classifier accepts.
 * Other failures keep their text. Upstreams are loopback fixtures.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import {
  AdmissionRelay,
  describeRelayFailure,
  isUnsentFailure,
  type RelayFailure,
  type RelayFailurePhase,
} from "../src/admission.ts";
import { UNSENT_FAILURE_NOTE } from "../src/completion.ts";
import { errorMessage, resultLine, runNative } from "./support/native.ts";

const context = {
  messages: [
    { role: "system", content: "system", timestamp: 0 },
    { role: "user", content: "hello", timestamp: 1 },
  ],
} as unknown as TranscriptContext;

// Documentation addresses: none of their digits read as an HTTP status to Pi.
const V4 = { syscall: "connect", address: "192.0.2.1", port: 443 };
const V6 = { syscall: "connect", address: "2001:db8::1", port: 443 };

function failure(
  phase: RelayFailurePhase,
  code: string | null,
  extra: Partial<RelayFailure> = {},
): RelayFailure {
  return { name: "Error", phase, message: null, code, syscall: null, address: null, port: null, causes: [], ...extra };
}

function failed(errorMessage: string): AssistantMessage {
  return { stopReason: "error", errorMessage } as AssistantMessage;
}

test("only transient connect-phase errors are unsent failures", () => {
  const unsent: Array<[string, RelayFailure]> = [
    ["the observed IPv4 timeout and unreachable IPv6", failure("connect", "ETIMEDOUT", {
      name: "AggregateError",
      causes: [{ code: "ETIMEDOUT", ...V4 }, { code: "EHOSTUNREACH", ...V6 }],
    })],
    ["an AggregateError without its own code", failure("connect", null, {
      name: "AggregateError",
      causes: [{ code: "ECONNREFUSED", ...V4 }, { code: "ENETUNREACH", ...V6 }],
    })],
    ...["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND"]
      .map((code): [string, RelayFailure] => [code, failure("connect", code)]),
    ["the relay's own timeout", failure("connect", null, { name: "RelayError", message: "Upstream request timed out" })],
  ];
  for (const [name, item] of unsent) assert.equal(isUnsentFailure(item), true, name);

  const sent: Array<[string, RelayFailure]> = [
    ["a reset after connecting", failure("request", "ECONNRESET")],
    ["a reset after the response began", failure("response", "ECONNRESET")],
    ["the relay's timeout after connecting", failure("request", null, { name: "RelayError", message: "Upstream request timed out" })],
    ["a failure reading the native request", failure("request-body", "ECONNRESET")],
    ["a certificate error", failure("connect", "CERT_HAS_EXPIRED")],
    ["an unknown code", failure("connect", "EPROTO")],
    ["no code", failure("connect", null)],
    ["an AggregateError with one permanent address", failure("connect", "ETIMEDOUT", {
      name: "AggregateError",
      causes: [{ code: "ETIMEDOUT", ...V4 }, { code: "EACCES", ...V6 }],
    })],
    ["an AggregateError with one address lacking a code", failure("connect", "ETIMEDOUT", {
      name: "AggregateError",
      causes: [{ code: "ETIMEDOUT", ...V4 }, { code: null, ...V6 }],
    })],
    ...[
      "Native request aborted",
      "Native response closed before upstream completion",
      "Admission relay closed before forwarding",
    ].map((message): [string, RelayFailure] => [message, failure("connect", null, { name: "RelayError", message })]),
  ];
  for (const [name, item] of sent) assert.equal(isUnsentFailure(item), false, name);
});

test("every address counts, including those past the diagnostic's cap", () => {
  const refused = (address: string) => Object.assign(new Error("refused"), { code: "ECONNREFUSED", syscall: "connect", address, port: 443 });
  const addresses = Array.from({ length: 8 }, (_, index) => refused(`192.0.2.${index + 1}`));
  const denied = Object.assign(new Error("denied"), { code: "EACCES", syscall: "connect", address: "192.0.2.9", port: 443 });

  const permanent = describeRelayFailure(
    Object.assign(new AggregateError([...addresses, denied]), { code: "ECONNREFUSED" }),
    "connect",
  );
  assert.equal(permanent.failure.causes.length, 8);
  assert.equal(permanent.unsent, false);

  const transient = describeRelayFailure(
    Object.assign(new AggregateError([...addresses, refused("192.0.2.9")]), { code: "ECONNREFUSED" }),
    "connect",
  );
  assert.equal(transient.failure.causes.length, 8);
  assert.equal(transient.unsent, true);
});

test("Pi retries the note and does not read it as context overflow", () => {
  // Pi 1.6.0 also retries codes such as ETIMEDOUT by themselves (#106). For
  // codes it does not list, and on earlier Pi, the note makes the retry.
  const unsent =
    "Incomplete upstream response: first upstream attempt: status unknown, capture incomplete, " +
    "relay failure AggregateError EHOSTUNREACH during connect " +
    "[EHOSTUNREACH connect 192.0.2.1:443; ENETUNREACH connect [2001:db8::1]:443], native retries denied: 0";
  // Without the note, Pi treats this failure as permanent.
  assert.equal(isRetryableAssistantError(failed(unsent)), false);
  const noted = failed(unsent + UNSENT_FAILURE_NOTE);
  assert.equal(isRetryableAssistantError(noted), true);
  assert.equal(isContextOverflow(noted), false);
});

test("a refused upstream connection fails as a retryable unsent failure", async (t) => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const address = closed.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve) => closed.close(resolve));

  const outcome = await runNative(t, {
    context,
    // The child sends its request; the relay finds nothing listening upstream.
    upstream: { body: "" },
    env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}` },
    stdout: [resultLine("success")],
  });
  const message = errorMessage(outcome.events);
  assert.match(message.errorMessage ?? "", /ECONNREFUSED connect 127\.0\.0\.1:\d+ during connect/);
  assert.equal(message.errorMessage?.endsWith(UNSENT_FAILURE_NOTE), true);
  assert.equal(isRetryableAssistantError(message), true);
  assert.equal(isContextOverflow(message), false);
  assert.equal(outcome.upstreamRequests.length, 0);
});

test("a dropped response keeps its text without the note", async (t) => {
  const outcome = await runNative(t, {
    context,
    upstream: { body: 'event: message_start\ndata: {"type":"message_start"}\n\n' },
    stdout: [resultLine("success")],
  });
  const message = errorMessage(outcome.events);
  assert.match(message.errorMessage ?? "", /^Incomplete upstream response: /);
  assert.equal(message.errorMessage?.includes(UNSENT_FAILURE_NOTE), false);
});

test("the retry after a 401 authentication error can fail unsent", async (t) => {
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(401, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "revoked" } }));
      // Nothing listens when Claude Code sends its refreshed request.
      upstream.close();
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const relay = await AdmissionRelay.create(`http://127.0.0.1:${address.port}`, 5_000);
  t.after(() => relay.close());
  const send = async (): Promise<number> => {
    const response = await fetch(`${relay.url}/v1/messages`, { method: "POST", body: "{}" });
    await response.text();
    return response.status;
  };

  assert.deepEqual([await send(), await send()], [401, 502]);
  assert.equal(relay.admitted, 2);
  assert.equal(relay.status, null);
  assert.equal(relay.failure?.code, "ECONNREFUSED");
  assert.equal(relay.unsentFailure, true);
});
