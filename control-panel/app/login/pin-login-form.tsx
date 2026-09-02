"use client";

import { FormEvent, useState } from "react";

export function PinLoginForm() {
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/login", {
        body: JSON.stringify({ pin }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || "The dashboard could not be unlocked.");
      window.location.assign("/");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-8">
      <label className="field">
        <span>Dashboard PIN</span>
        <input
          autoComplete="current-password"
          autoFocus
          disabled={busy}
          inputMode="numeric"
          maxLength={12}
          minLength={6}
          name="pin"
          onChange={(event) => setPin(event.target.value.replace(/\D/gu, "").slice(0, 12))}
          pattern="[0-9]{6,12}"
          placeholder="••••••"
          required
          type="password"
          value={pin}
        />
      </label>
      {message && (
        <p className="mt-3 rounded-xl border border-[#d9b5ad] bg-[#fff4f1] px-4 py-3 text-sm text-[#7b3024]" role="alert">
          {message}
        </p>
      )}
      <button
        className="mt-4 w-full rounded-full bg-[#b8ff5a] px-5 py-3 text-sm font-black text-[#172018] disabled:cursor-not-allowed disabled:opacity-50"
        disabled={busy || pin.length < 6}
        type="submit"
      >
        {busy ? "Checking…" : "Unlock command center"}
      </button>
    </form>
  );
}
