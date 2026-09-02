import { redirect } from "next/navigation";
import { hasPinSession } from "../pin-auth";
import { PinLoginForm } from "./pin-login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await hasPinSession()) redirect("/");

  return (
    <main className="grid min-h-screen place-items-center bg-[#172018] px-5 py-12 text-[#f7f9f2]">
      <section className="w-full max-w-md rounded-[1.75rem] border border-[#465148] bg-[#202a22] p-6 shadow-[0_24px_80px_rgb(0_0_0/32%)] sm:p-8">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-[#b8ff5a] font-mono text-sm font-black text-[#172018]">AB</span>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#aab4a9]">Private operator access</p>
            <h1 className="text-xl font-semibold tracking-tight">AUTOBOT Command Center</h1>
          </div>
        </div>
        <div className="mt-8 border-t border-[#465148] pt-7">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#b8ff5a]">System locked</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">Enter your PIN</h2>
          <p className="mt-3 text-sm leading-6 text-[#b8c0b8]">
            This dashboard controls paired AUTOBOT devices. Access expires automatically after 12 hours.
          </p>
          <PinLoginForm />
        </div>
        <p className="mt-6 text-center text-[11px] leading-5 text-[#89938b]">
          Failed attempts are rate-limited. Device credentials and event login details are never shown here.
        </p>
      </section>
    </main>
  );
}
