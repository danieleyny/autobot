import {
  constants,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
} from "node:crypto";

export type DeviceKeyPair = {
  publicKeyPem: string;
  privateKeyPem: string;
};

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

export function isValidDevicePublicKey(publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048;
  } catch {
    return false;
  }
}

export function encryptForDevice(plaintext: string, publicKeyPem: string): string {
  return publicEncrypt(
    {
      key: publicKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(plaintext, "utf8"),
  ).toString("base64url");
}

export function decryptForDevice(ciphertext: string, privateKeyPem: string): string {
  return privateDecrypt(
    {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(ciphertext, "base64url"),
  ).toString("utf8");
}
