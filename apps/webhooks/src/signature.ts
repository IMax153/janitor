import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

export const Signature = Schema.String.check(Schema.isPattern(/^sha256=[0-9a-f]{64}$/i))

export class CryptoError extends Data.TaggedError("CryptoError")<{
  readonly cause: unknown
}> {}

const fromHex = (hex: string): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

export const verifySignature = Effect.fn("Webhook.verifySignature")(function* (
  secret: Redacted.Redacted<string>,
  signature: string,
  body: Uint8Array,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(Redacted.value(secret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      )
      return crypto.subtle.verify(
        "HMAC",
        key,
        fromHex(signature.slice("sha256=".length)),
        new Uint8Array(body),
      )
    },
    catch: (cause) => new CryptoError({ cause }),
  })
})
