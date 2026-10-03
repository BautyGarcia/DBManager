"use client";
import { supabase } from "@/lib/supabase";
export default async function Page() {
  const { data } = await supabase.from("posts").select("*").eq("published", true);
  const { data: { user } } = await supabase.auth.getUser();
  const { data: url } = supabase.storage.from("avatars").getPublicUrl("x.png");
  const ch = supabase.channel("posts").on("postgres_changes", { event: "*", schema: "public" }, () => {}).subscribe();
  await supabase.rpc("increment_views", { post_id: 1 });
  await supabase.functions.invoke("send-email");
  return null;
}
