"use server";

import { redirect } from "next/navigation";
import { supabaseServidor } from "@/server/supabase";

export async function sair() {
  const supabase = await supabaseServidor();
  await supabase.auth.signOut();
  redirect("/login");
}
