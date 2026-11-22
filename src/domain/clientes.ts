export const TIPOS_CLIENTE = ["familia", "casal", "individual", "grupo"] as const;
export type TipoCliente = (typeof TIPOS_CLIENTE)[number];
export const NOMES_TIPO_CLIENTE: Record<TipoCliente, string> = {
  familia: "Família",
  casal: "Casal",
  individual: "Individual",
  grupo: "Grupo",
};

// ---------- CPF ----------

export function normalizarCpf(texto: string): string {
  return texto.replace(/\D/g, "");
}

export function cpfValido(digitos: string): boolean {
  if (!/^\d{11}$/.test(digitos)) return false;
  if (/^(\d)\1{10}$/.test(digitos)) return false;
  const calc = (tamanho: number) => {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += Number(digitos[i]) * (tamanho + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return calc(9) === Number(digitos[9]) && calc(10) === Number(digitos[10]);
}

export function formatarCpf(digitos: string): string {
  if (digitos.length !== 11) return digitos;
  return `${digitos.slice(0, 3)}.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-${digitos.slice(9)}`;
}

// ---------- Telefone ----------

export function normalizarTelefone(texto: string): string {
  return texto.replace(/\D/g, "");
}

export function telefoneValido(digitos: string): boolean {
  return /^\d{10,11}$/.test(digitos);
}

export function formatarTelefone(digitos: string): string {
  if (digitos.length === 11) return `(${digitos.slice(0, 2)}) ${digitos[2]} ${digitos.slice(3, 7)}-${digitos.slice(7)}`;
  if (digitos.length === 10) return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 6)}-${digitos.slice(6)}`;
  return digitos;
}

// ---------- Código ----------

export function formatarCodigoCliente(n: number): string {
  return `ECL-${String(n).padStart(4, "0")}`;
}

// ---------- Nome do grupo ----------

function ultimoSobrenome(nome: string): string {
  const partes = nome.trim().split(/\s+/);
  return partes[partes.length - 1] ?? "";
}

export function nomeDoGrupo(tipo: TipoCliente, titular: string, informado?: string): string {
  const dado = informado?.trim();
  if (dado) return dado;
  if (tipo === "familia") return `Família ${ultimoSobrenome(titular)}`;
  if (tipo === "casal") return `Casal ${ultimoSobrenome(titular)}`;
  return titular.trim();
}

// ---------- Datas ISO (AAAA-MM-DD), aritmética em UTC ao meio-dia ----------

function partes(iso: string): [number, number, number] {
  const [a, m, d] = iso.split("-").map(Number);
  return [a, m, d];
}

function diaUtc(a: number, m: number, d: number): number {
  return Date.UTC(a, m - 1, d, 12) / 86_400_000;
}

function bissexto(a: number): boolean {
  return (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;
}

const dois = (n: number) => String(n).padStart(2, "0");

export function idade(nascimento: string, hoje: string): number {
  const [an, mn, dn] = partes(nascimento);
  const [ah, mh, dh] = partes(hoje);
  let anos = ah - an;
  if (mh < mn || (mh === mn && dh < dn)) anos -= 1;
  return anos;
}

export function hojeEmCuiaba(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Cuiaba" }).format(agora);
}

/** Data (AAAA-MM-DD) de um instante em Cuiabá: 2026-11-21T02:00Z → "2026-11-20". */
export function dataEmCuiaba(d: Date): string {
  return hojeEmCuiaba(d);
}

// ---------- Alertas ----------

export type AlertaCliente = {
  tipo: "sem_passaporte" | "passaporte_vencido" | "passaporte_volta" | "aniversario";
  pessoa: string;
  /** Id da pessoa, quando ela já está gravada (a ficha destaca a linha por ele). */
  pessoaId?: string;
  texto: string;
};

type PessoaAlerta = {
  id?: string;
  nome: string;
  titular: boolean;
  nascimento: string | null;
  passaporte?: string | null;
  validadePassaporte: string | null;
};

/** Viagem futura do cliente para o aviso de passaporte × volta (o chamador passa só as `aprovado`/`vendida`). */
export type ViagemAlerta = {
  destino: string;
  /** Data da volta (AAAA-MM-DD). */
  fim: string;
  internacional: boolean;
  /** Ids das pessoas que viajam. */
  passageiros: string[];
};

const JANELA_ANIVERSARIO_DIAS = 30;
/** Passaporte precisa valer 6 meses depois da volta (regra mais segura; a Europa pede 3). */
export const DIAS_PASSAPORTE_APOS_VOLTA = 182;

function somarDias(iso: string, dias: number): string {
  const [a, m, d] = partes(iso);
  return new Date((diaUtc(a, m, d) + dias) * 86_400_000).toISOString().slice(0, 10);
}

function dataBr(iso: string): string {
  const [a, m, d] = partes(iso);
  return `${dois(d)}/${dois(m)}/${a}`;
}

// Próxima ocorrência (>= hoje) do aniversário; 29/02 em ano não bissexto vira 28/02.
function proximoAniversario(nascimento: string, hoje: string): { dias: number; dia: number; mes: number } {
  const [ah, mh, dh] = partes(hoje);
  const [, mn, dn] = partes(nascimento);
  const ocorrencia = (ano: number) => {
    const dia = mn === 2 && dn === 29 && !bissexto(ano) ? 28 : dn;
    return { dias: diaUtc(ano, mn, dia), dia, mes: mn };
  };
  const base = diaUtc(ah, mh, dh);
  let o = ocorrencia(ah);
  if (o.dias < base) o = ocorrencia(ah + 1);
  return { dias: o.dias - base, dia: o.dia, mes: o.mes };
}

/**
 * Alertas da ficha: passaporte (sem cadastro, vencido, ou vencendo menos de 6 meses depois da volta de uma
 * viagem internacional que ainda não terminou) e aniversário nos próximos 30 dias. Em grupo, documento do
 * titular e de cada passageiro de uma viagem internacional futura. Sem passaporte (nem número, nem validade) e com viagem: um aviso por viagem, com destino e volta,
 * no lugar do genérico.
 */
export function alertasDoCliente(
  c: { tipo: TipoCliente; pessoas: PessoaAlerta[] },
  hoje: string,
  viagens: ViagemAlerta[] = [],
): AlertaCliente[] {
  const alertas: AlertaCliente[] = [];
  const futuras = viagens.filter((v) => v.internacional && v.fim >= hoje);
  for (const p of c.pessoas) {
    const quem = { pessoa: p.nome, ...(p.id ? { pessoaId: p.id } : {}) };
    const minhas = p.id ? futuras.filter((v) => v.passageiros.includes(p.id!)) : [];
    // Em grupo, sem viagem, só o titular; quem embarca numa viagem internacional é conferido sempre.
    const checaDocumento = c.tipo !== "grupo" || p.titular || minhas.length > 0;
    if (checaDocumento) {
      if (!p.validadePassaporte) {
        const temNumero = !!p.passaporte?.trim();
        if (!temNumero && minhas.length > 0) {
          for (const v of minhas) {
            alertas.push({
              tipo: "sem_passaporte",
              ...quem,
              texto: `${p.nome} não tem passaporte cadastrado para ${v.destino} (${dataBr(v.fim)}).`,
            });
          }
        } else {
          alertas.push({
            tipo: "sem_passaporte",
            ...quem,
            texto: temNumero ? `${p.nome} não tem a validade do passaporte cadastrada.` : `${p.nome} não tem passaporte cadastrado.`,
          });
        }
      } else if (p.validadePassaporte < hoje) {
        alertas.push({
          tipo: "passaporte_vencido",
          ...quem,
          texto: `Passaporte de ${p.nome} venceu em ${dataBr(p.validadePassaporte)}.`,
        });
      } else {
        for (const v of minhas) {
          if (p.validadePassaporte < somarDias(v.fim, DIAS_PASSAPORTE_APOS_VOLTA)) {
            alertas.push({
              tipo: "passaporte_volta",
              ...quem,
              texto: `Passaporte de ${p.nome} vence em ${dataBr(p.validadePassaporte)}, menos de 6 meses depois da volta de ${v.destino}.`,
            });
          }
        }
      }
    }
    if (p.nascimento) {
      const prox = proximoAniversario(p.nascimento, hoje);
      if (prox.dias <= JANELA_ANIVERSARIO_DIAS) {
        alertas.push({
          tipo: "aniversario",
          ...quem,
          texto: `${p.nome} faz aniversário em ${dois(prox.dia)}/${dois(prox.mes)}${prox.dias === 0 ? " (hoje)" : ""}.`,
        });
      }
    }
  }
  return alertas;
}
