import { CommandCenter } from "./command-center";
import { requirePinSession } from "./pin-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requirePinSession();
  return <CommandCenter operatorName="PIN access" />;
}
