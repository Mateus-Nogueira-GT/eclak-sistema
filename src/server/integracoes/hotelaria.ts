import "server-only";

// Expedia TAAP e Infotera (New Age): sem contrato e sem documentação da API, então só a forma da busca (R-C7).
// Nenhuma URL, nenhuma variável de ambiente: quando houver documentação, um adaptador implementa `ProvedorHotelaria`
// e `provedorHotelaria()` passa a devolvê-lo quando estiver configurado. Até lá, Admin › Integrações mostra a
// integração desligada, aguardando o contrato e a documentação da API.

export type RegimeRefeicao = "sem_refeicao" | "cafe_da_manha" | "meia_pensao" | "pensao_completa" | "tudo_incluido";

export type QuartoPedido = {
  adultos: number;
  /** Idade de cada criança no quarto, em anos. */
  idadesCriancas: number[];
};

export type BuscaHotelaria = {
  /** Cidade ou região, como a pessoa digitou. */
  destino: string;
  /** AAAA-MM-DD. */
  entrada: string;
  /** AAAA-MM-DD. */
  saida: string;
  quartos: QuartoPedido[];
  refeicao?: RegimeRefeicao;
  /** Só tarifas reembolsáveis. */
  soReembolsavel?: boolean;
};

export type TarifaHotelaria = {
  /** Código da tarifa no provedor (para reservar depois). */
  codigo: string;
  descricaoQuarto: string;
  refeicao: RegimeRefeicao | null;
  reembolsavel: boolean;
  /** Prazo para cancelar sem multa, ISO; null quando não há. */
  cancelarAte: string | null;
  /** Total da estadia em centavos, na moeda do provedor. */
  totalCentavos: bigint;
  /** Código ISO 4217 (BRL, EUR, USD…). */
  moeda: string;
};

export type HotelEncontrado = {
  /** Código do hotel no provedor. */
  codigo: string;
  nome: string;
  cidade: string;
  endereco: string | null;
  estrelas: number | null;
  tarifas: TarifaHotelaria[];
};

export interface ProvedorHotelaria {
  /** Nome para a tela ("Expedia TAAP", "Infotera"). */
  readonly nome: string;
  buscar(busca: BuscaHotelaria, opcoes?: { signal?: AbortSignal }): Promise<HotelEncontrado[]>;
}

/** Nenhum provedor de hotelaria ligado (sem contrato nem documentação). */
export function provedorHotelaria(): ProvedorHotelaria | null {
  return null;
}
