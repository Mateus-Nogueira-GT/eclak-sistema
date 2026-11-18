import { describe, expect, it } from "vitest";
import { garantirBancoLocal } from "../helpers/db";

describe("garantirBancoLocal", () => {
  it("aceita URLs locais", () => {
    expect(() =>
      garantirBancoLocal(
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        "http://localhost:54321",
      ),
    ).not.toThrow();
  });
  it("recusa banco de produção", () => {
    expect(() =>
      garantirBancoLocal(
        "postgresql://u:p@db.abc.supabase.co:5432/postgres",
        "http://127.0.0.1:54321",
      ),
    ).toThrow(/DATABASE_URL/);
  });
  it("recusa API de produção", () => {
    expect(() =>
      garantirBancoLocal(
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        "https://abc.supabase.co",
      ),
    ).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
  it("recusa URL vazia", () => {
    expect(() => garantirBancoLocal("", "")).toThrow();
  });
});
