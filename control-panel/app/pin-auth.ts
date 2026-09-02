import { env } from "cloudflare:workers";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const PIN_SESSION_COOKIE = "autobot_pin_session";
export const CONTROLLER_OWNER_ID = "autobot-primary-controller";

const SESSION_LIFETIME_SECONDS = 12 * 60 * 60;
const PIN_HASH_VERSION = "pbkdf2-sha256";

type RuntimeSecrets = {
  AUTOBOT_PIN_HASH?: string;
  AUTOBOT_SESSION_SECRET?: string;
};

type SessionPayload = {
  expiresAt: number;
  version: 1;
};

function runtimeSecret(name: keyof RuntimeSecrets): string {
  const workerValue = (env as unknown as RuntimeSecrets)[name];
  const nodeValue = typeof process !== "undefined" ? process.env[name] : undefined;
  const value = workerValue ?? nodeValue;
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function hmac(value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(runtimeSecret("AUTOBOT_SESSION_SECRET")),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

export async function createPinSessionToken(now = Date.now()): Promise<string> {
  const payload: SessionPayload = {
    expiresAt: now + SESSION_LIFETIME_SECONDS * 1_000,
    version: 1,
  };
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encodedPayload}.${encodeBase64Url(await hmac(encodedPayload))}`;
}

export async function isValidPinSession(token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra) return false;
  const signature = decodeBase64Url(encodedSignature);
  if (!signature || !constantTimeEqual(signature, await hmac(encodedPayload))) return false;
  const payloadBytes = decodeBase64Url(encodedPayload);
  if (!payloadBytes) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<SessionPayload>;
    return payload.version === 1 && typeof payload.expiresAt === "number" && payload.expiresAt > now;
  } catch {
    return false;
  }
}

export async function hasPinSession(): Promise<boolean> {
  const store = await cookies();
  return isValidPinSession(store.get(PIN_SESSION_COOKIE)?.value);
}

export async function requirePinSession(): Promise<void> {
  if (!(await hasPinSession())) redirect("/login");
}

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    maxAge: SESSION_LIFETIME_SECONDS,
    path: "/",
    sameSite: "strict" as const,
    secure,
  };
}

export async function verifyConfiguredPin(pin: string): Promise<boolean> {
  const [version, iterationText, saltText, expectedText, extra] = runtimeSecret("AUTOBOT_PIN_HASH").split(":");
  const iterations = Number(iterationText);
  const salt = decodeBase64Url(saltText ?? "");
  const expected = decodeBase64Url(expectedText ?? "");
  if (
    version !== PIN_HASH_VERSION ||
    extra ||
    !Number.isInteger(iterations) ||
    iterations < 100_000 ||
    !salt ||
    salt.length < 16 ||
    !expected ||
    expected.length !== 32
  ) {
    throw new Error("AUTOBOT_PIN_HASH has an invalid format.");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const actual = new Uint8Array(
    await crypto.subtle.deriveBits(
      { hash: "SHA-256", iterations, name: "PBKDF2", salt },
      material,
      expected.length * 8,
    ),
  );
  return constantTimeEqual(actual, expected);
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
