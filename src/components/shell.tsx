"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { LogOut, MessagesSquare } from "lucide-react";
import { podeAcessar, ROTAS_POR_PERFIL, type Perfil } from "@/domain/perfis";
import { sair } from "@/app/(app)/actions";
import { ChatIA } from "./chat-ia";
import { cx } from "./ui";

type Item = { href: string; label: string };
const areas: { titulo: string; itens: Item[] }[] = [
  {
    titulo: "Comercial",
    itens: [
      { href: "/clientes", label: "Clientes" },
      { href: "/vendas", label: "Fechamento da venda" },
    ],
  },
  {
    titulo: "Operação",
    itens: [
      { href: "/viagens", label: "Viagens" },
      { href: "/tarefas", label: "Tarefas" },
      { href: "/roteiros", label: "Roteiros" },
      { href: "/dailies", label: "Dailies" },
      { href: "/fornecedores", label: "Fornecedores" },
    ],
  },
  {
    titulo: "Gestão",
    itens: [
      { href: "/visao-geral", label: "Visão geral" },
      { href: "/aprovacoes", label: "Aprovações" },
    ],
  },
  {
    titulo: "Financeiro",
    itens: [
      { href: "/financeiro/lancamentos", label: "Lançamentos" },
      { href: "/financeiro/caixa", label: "Fluxo de caixa" },
      { href: "/financeiro/relatorios", label: "Relatórios" },
      { href: "/financeiro/faturas", label: "Faturas" },
      { href: "/financeiro/notas-fiscais", label: "Notas fiscais" },
      { href: "/financeiro/categorias", label: "Categorias" },
      { href: "/financeiro/contas-bancarias", label: "Contas bancárias" },
      { href: "/financeiro/conciliacao", label: "Conciliação" },
      { href: "/financeiro/cartoes", label: "Cartões corporativos" },
    ],
  },
  {
    titulo: "Administração",
    itens: [
      { href: "/admin/usuarios", label: "Usuários e acessos" },
      { href: "/admin/parametros", label: "Parâmetros" },
      { href: "/admin/integracoes", label: "Integrações" },
    ],
  },
];

function ativo(path: string, href: string) {
  return path === href || path.startsWith(href + "/");
}

export function Shell({
  perfil,
  nome,
  perfilNome,
  iaLigada,
  children,
}: {
  perfil: Perfil;
  nome: string;
  perfilNome: string;
  /** IA configurada no servidor: só então o botão do chat aparece. */
  iaLigada: boolean;
  children: ReactNode;
}) {
  const path = usePathname();
  const [chatAberto, setChatAberto] = useState(false);
  const visiveis = areas
    .map((a) => ({ ...a, itens: a.itens.filter((i) => podeAcessar(perfil, i.href)) }))
    .filter((a) => a.itens.length);
  const atual = visiveis.find((a) => a.itens.some((i) => ativo(path, i.href))) ?? visiveis[0];

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="sticky top-0 z-30 print:hidden">
        <div className="border-b border-linha bg-white">
          <div className="mx-auto flex h-[64px] max-w-[1440px] items-center gap-4 px-4 md:gap-8 md:px-8">
            <Link href={ROTAS_POR_PERFIL[perfil][0]} className="shrink-0" aria-label="ECLAK Viagens, início">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo-eclak.png" alt="ECLAK Viagens" className="h-[34px] w-auto" />
            </Link>
            <nav className="flex h-full items-stretch gap-1" aria-label="Áreas">
              {visiveis.map((a) => {
                const on = a === atual;
                return (
                  <Link key={a.titulo} href={a.itens[0].href} className={cx("relative flex items-center px-3 text-[14.5px] transition-colors", on ? "font-bold text-verde" : "font-medium text-cinza hover:text-verde")}>
                    {a.titulo}
                    {on && <span className="absolute inset-x-3 bottom-0 h-[3px] bg-verde" />}
                  </Link>
                );
              })}
            </nav>
            <div className="ml-auto flex items-center gap-3">
              {iaLigada && (
                <button
                  type="button"
                  onClick={() => setChatAberto(true)}
                  aria-expanded={chatAberto}
                  className="flex cursor-pointer items-center gap-2 rounded-[5px] border border-linha px-3 py-1.5 text-[14px] font-medium text-verde hover:bg-fundo"
                >
                  <MessagesSquare size={16} /> Chat com IA
                </button>
              )}
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-verde text-[13px] font-bold text-white">{nome[0]}</span>
              <span className="hidden text-left leading-tight md:block">
                <span className="block text-[13.5px] font-bold text-texto">{nome}</span>
                <span className="block text-[11.5px] text-cinza">{perfilNome}</span>
              </span>
              <form action={sair}>
                <button type="submit" className="flex cursor-pointer items-center gap-2 rounded-[5px] px-3 py-2 text-[14px] font-medium text-texto hover:bg-fundo">
                  <LogOut size={16} className="text-cinza" /> Sair
                </button>
              </form>
            </div>
          </div>
        </div>
        <div className="border-b border-linha bg-fundo">
          <nav className="mx-auto flex h-[46px] max-w-[1440px] items-stretch gap-6 overflow-x-auto px-4 md:gap-7 md:px-8" aria-label={atual.titulo}>
            {atual.itens.map((m) => {
              const on = ativo(path, m.href);
              return (
                <Link key={m.href} href={m.href} className={cx("-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 text-[14px] transition-colors", on ? "border-verde font-bold text-verde" : "border-transparent font-medium text-cinza hover:text-texto")}>
                  {m.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      {iaLigada && <ChatIA aberto={chatAberto} onFechar={() => setChatAberto(false)} perfilNome={perfilNome} />}
      <main className="mx-auto w-full min-w-0 max-w-[1440px] flex-1 px-4 pb-20 pt-6 md:px-8 md:pt-9 print:max-w-none print:p-0">{children}</main>
    </div>
  );
}
