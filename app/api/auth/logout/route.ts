import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest, PIN_SESSION_COOKIE, sessionCookieOptions } from "../../../pin-auth";

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "The request origin is not allowed." }, { status: 403 });
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.cookies.set(PIN_SESSION_COOKIE, "", { ...sessionCookieOptions(request.nextUrl.protocol === "https:"), maxAge: 0 });
  response.headers.set("cache-control", "no-store");
  return response;
}
