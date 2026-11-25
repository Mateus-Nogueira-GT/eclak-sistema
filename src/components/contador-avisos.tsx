"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { contarAvisos } from "@/server/actions/avisos";
import { cx } from "./ui";

/** Evento da janela que pede ao sino para contar de novo (a página de avisos dispara depois de cada gravação). */
const EVENTO = "eclak:avisos-mudaram";

/** Chamar depois de dispensar, desfazer, criar ou resolver: o pathname não muda, então o sino precisa ser avisado. */
export function avisosMudaram() {
  window.dispatchEvent(new Event(EVENTO));
}

/**
 * Sino do topo (spec 5b §8.5 e §14): quantos avisos abertos "para mim", lido por `contarAvisos()` ao montar, a cada
 * troca de rota e quando a página de avisos grava algo. Sem número quando é zero. Só a última resposta vale; falha
 * mantém o número anterior.
 */
export function ContadorAvisos() {
  const path = usePathname();
  const [total, setTotal] = useState(0);
  const [pedido, setPedido] = useState(0);

  useEffect(() => {
    const recontar = () => setPedido((n) => n + 1);
    window.addEventListener(EVENTO, recontar);
    return () => window.removeEventListener(EVENTO, recontar);
  }, []);

  useEffect(() => {
    let valido = true;
    contarAvisos().then(
      (n) => {
        if (valido) setTotal(n);
      },
      () => {},
    );
    return () => {
      valido = false;
    };
  }, [path, pedido]);

  const rotulo = total === 0 ? "Avisos: nenhum aberto" : total === 1 ? "Avisos: 1 aberto" : `Avisos: ${total} abertos`;
  return (
    <Link
      href="/avisos"
      aria-label={rotulo}
      title={rotulo}
      className={cx("relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-cinza hover:bg-fundo hover:text-verde", path === "/avisos" && "text-verde")}
    >
      <Bell size={19} />
      {total > 0 && (
        <span className="num absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-terracota px-1 text-[11px] font-bold leading-none text-white">
          {total > 99 ? "99+" : total}
        </span>
      )}
    </Link>
  );
}
