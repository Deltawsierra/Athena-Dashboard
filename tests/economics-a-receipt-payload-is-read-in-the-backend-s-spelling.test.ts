import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import { MASTER, exchange, fixture, served } from "./helpers/economics-fixtures";
import { asciiSpelling, receiptIdOf, signedDocumentSpelling } from "@shared/economics-receipt";

/**
 * The rule the receipt checks rest on (shared/economics-receipt.ts): a receipt's
 * DSSE payload is the document in the spelling it is signed over (mythos_core's
 * canonical bytes, UTF-8), and the report's `receipt.document_digest` is the
 * SHA-256 of the backend's ASCII spelling of the same document
 * (models.canonical_digest). The payload respelled -- every unit outside
 * printable ASCII written `\uXXXX` -- has that digest. Pinned against the
 * backend's own functions (canonical-spellings: an accent, a currency sign, a line
 * separator, a delete, a character past the first plane, a quote and a backslash)
 * and the receipt the backend served.
 */

const sha256 = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const envelopeOf = (payload: string) => new TextEncoder().encode(JSON.stringify({ payload, payloadType: "x", signatures: [] }));

describe("a receipt's payload, in the backend's spelling", () => {
  const spellings = fixture(MASTER, "canonical-spellings");

  it("respelled, has the digest the backend names for the document, where the payload as signed has not", () => {
    expect(spellings.cases?.length).toBeGreaterThanOrEqual(3);
    for (const one of spellings.cases!) {
      const signed = Buffer.from(one.payload_hex, "hex");
      // The signed spelling is not ASCII: the digest is not of it.
      expect(signed.some((byte) => byte > 0x7e)).toBe(true);
      expect(sha256(signed)).not.toBe(one.document_digest);
      const spelling = signedDocumentSpelling(envelopeOf(signed.toString("base64")));
      expect(spelling).not.toBeNull();
      expect(sha256(spelling!)).toBe(one.document_digest);
    }
  });

  it("the receipt the backend served signs the document whose digest its report names", () => {
    const graded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
    const report = served(graded, "report") as Record<string, any>;
    const bytes = new TextEncoder().encode(exchange(graded, "receipt").body);
    expect(sha256(signedDocumentSpelling(bytes)!)).toBe(report.receipt.document_digest);
  });

  it("writes every unit outside printable ASCII as \\uXXXX, lowercase, a pair past the first plane, and nothing else", () => {
    expect(asciiSpelling('{"a":"café","b":"\u007f","c":"\u{1f4b6}","d":"\\"q\\" \\\\","e":" "}')).toBe(
      '{"a":"caf\\u00e9","b":"\\u007f","c":"\\ud83d\\udcb6","d":"\\"q\\" \\\\","e":"\\u2028"}',
    );
    expect(asciiSpelling(" ~")).toBe(" ~");
  });

  it("reads only one spelling of the payload: strict base64 of UTF-8 text in a JSON object", () => {
    const one = Buffer.from(spellings.cases![0].payload_hex, "hex").toString("base64");
    const variants = [`${one}\n`, ` ${one}`, one.replace(/=+$/, ""), one.replace(/\+/g, "-").replace(/\//g, "_"), "!!!!"];
    for (const payload of variants.filter((variant) => variant !== one)) {
      expect(signedDocumentSpelling(envelopeOf(payload)), JSON.stringify(payload)).toBeNull();
    }
    // A payload whose bits past its last byte are not zero spells the same bytes, but is not the one spelling.
    expect(signedDocumentSpelling(envelopeOf("QR=="))).toBeNull();
    expect(signedDocumentSpelling(envelopeOf("QQ=="))).not.toBeNull();
    expect(signedDocumentSpelling(envelopeOf(Buffer.from([0xc3, 0x28]).toString("base64")))).toBeNull();
    expect(signedDocumentSpelling(new TextEncoder().encode("[]"))).toBeNull();
    expect(signedDocumentSpelling(new TextEncoder().encode('{"payload":1}'))).toBeNull();
    expect(signedDocumentSpelling(new Uint8Array([0xff]))).toBeNull();
  });

  it("names a receipt by the report's id, undashed or dashed, and nothing else", () => {
    const hex = "8bcb2684e2c6446cbcebf18a8fcd8868";
    const dashed = "8bcb2684-e2c6-446c-bceb-f18a8fcd8868";
    expect(receiptIdOf(hex)).toEqual({ hex, dashed });
    expect(receiptIdOf(dashed)).toEqual({ hex, dashed });
    for (const bad of [hex.toUpperCase(), hex.slice(1), `${dashed}-`, "../x", "", 7, null]) expect(receiptIdOf(bad)).toBeNull();
  });
});
