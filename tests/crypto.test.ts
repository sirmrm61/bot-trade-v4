import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

import { encrypt, decrypt, maskSecret } from "@/infrastructure/encryption/crypto";

describe("AES-256-GCM credential encryption", () => {
  it("roundtrips plaintext", () => {
    const secret = "nobitex-api-secret-xyz";
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it("produces different ciphertext per call (random IV)", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("fails on tampered ciphertext (GCM auth tag)", () => {
    const [iv, tag, data] = encrypt("secret").split(".");
    const tampered = `${iv}.${tag}.${Buffer.from("tampered").toString("base64")}`;
    expect(() => decrypt(tampered)).toThrow();
    void data;
  });

  it("maskSecret never reveals the middle", () => {
    const masked = maskSecret("abcdefghijklmnop");
    expect(masked).toBe("abcd…mnop");
    expect(masked).not.toContain("efgh");
  });
});
