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

// ---------- Alertas ----------

export type AlertaCliente = {
  tipo: "sem_passaporte" | "passaporte_vencido" | "aniversario";
  pessoa: string;
  texto: string;
};

type PessoaAlerta = { nome: string; titular: boolean; nascimento: string | null; validadePassaporte: string | null };

const JANELA_ANIVERSARIO_DIAS = 30;

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

export function alertasDoCliente(
  c: { tipo: TipoCliente; pessoas: PessoaAlerta[] },
  hoje: string,
): AlertaCliente[] {
  const alertas: AlertaCliente[] = [];
  for (const p of c.pessoas) {
    const checaDocumento = c.tipo !== "grupo" || p.titular;
    if (checaDocumento) {
      if (!p.validadePassaporte) {
        alertas.push({ tipo: "sem_passaporte", pessoa: p.nome, texto: `${p.nome} não tem passaporte cadastrado.` });
      } else if (p.validadePassaporte < hoje) {
        alertas.push({
          tipo: "passaporte_vencido",
          pessoa: p.nome,
          texto: `Passaporte de ${p.nome} venceu em ${dataBr(p.validadePassaporte)}.`,
        });
      }
    }
    if (p.nascimento) {
      const prox = proximoAniversario(p.nascimento, hoje);
      if (prox.dias <= JANELA_ANIVERSARIO_DIAS) {
        alertas.push({
          tipo: "aniversario",
          pessoa: p.nome,
          texto: `${p.nome} faz aniversário em ${dois(prox.dia)}/${dois(prox.mes)}.${prox.dias === 0 ? " (hoje)" : ""}`,
        });
      }
    }
  }
  return alertas;
}
