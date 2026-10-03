"use server";
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
export async function del(id: number) { await admin.from("posts").delete().eq("id", id); }
