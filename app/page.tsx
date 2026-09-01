import { requireChatGPTUser } from "./chatgpt-auth";
import { CommandCenter } from "./command-center";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  return <CommandCenter operatorName={user.displayName} />;
}
