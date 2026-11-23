"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Badge, Botao, Campo, Card, CardHeader, Select, inputCls } from "@/components/ui";
import { Grade } from "@/components/kit";
import { FILIAIS, PERFIS, PERFIS_VALORES, type Filial, type Perfil } from "@/domain/perfis";
import { alterarUsuario, criarUsuario, reenviarConvite } from "@/server/actions/usuarios";

type Linha = {
  id: string;
  nome: string;
  email: string;
  perfil: Perfil;
  filial: Filial;
  ativo: boolean;
  convitePendente: boolean;
  cadastro: string;
};

const niveis = PERFIS_VALORES.map((p) => (
  <option key={p} value={p}>{PERFIS[p].nome}</option>
));
const filiais = FILIAIS.map((f) => <option key={f} value={f}>{f}</option>);

export function Equipe({ usuarios }: { usuarios: Linha[] }) {
  const [novo, setNovo] = useState(false);
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [perfil, setPerfil] = useState<Perfil>("consultor");
  const [filial, setFilial] = useState<Filial>("Rondonópolis");
  const [editando, setEditando] = useState<string | null>(null);
  const [ed, setEd] = useState<{ perfil: Perfil; filial: Filial; ativo: boolean }>({
    perfil: "consultor",
    filial: "Rondonópolis",
    ativo: true,
  });
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [pendente, iniciar] = useTransition();

  function enviarConvite() {
    setMsg(null);
    iniciar(async () => {
      const r = await criarUsuario({ nome, email, perfil, filial });
      if (r.ok) {
        setMsg({ tipo: "ok", texto: "Convite enviado. Próximo passo: o usuário cria a senha pelo link do e-mail" });
        setNovo(false);
        setNome("");
        setEmail("");
      } else {
        setMsg({ tipo: "erro", texto: r.erro });
      }
    });
  }

  function editar(u: Linha) {
    setMsg(null);
    setEditando(u.id);
    setEd({ perfil: u.perfil, filial: u.filial, ativo: u.ativo });
  }

  function reenviar(u: Linha) {
    setMsg(null);
    iniciar(async () => {
      const r = await reenviarConvite(u.id);
      setMsg(
        r.ok
          ? { tipo: "ok", texto: `Convite reenviado para ${u.email}` }
          : { tipo: "erro", texto: r.erro },
      );
    });
  }

  function salvar(id: string) {
    setMsg(null);
    iniciar(async () => {
      const r = await alterarUsuario(id, ed);
      if (r.ok) {
        setEditando(null);
        setMsg({ tipo: "ok", texto: "Alteração salva" });
      } else {
        setMsg({ tipo: "erro", texto: r.erro });
      }
    });
  }

  return (
    <>
      <div className="mb-5 flex justify-end">
        <Botao onClick={() => setNovo(!novo)}>
          <Plus size={16} /> Novo usuário
        </Botao>
      </div>

      {msg && (
        <p
          role="status"
          className={`mb-5 rounded-[5px] border px-4 py-3 text-[14px] ${msg.tipo === "ok" ? "border-verde/30 bg-verde/[0.06] text-texto" : "border-ouro bg-ouro/15 text-texto"}`}
        >
          {msg.texto}
        </p>
      )}

      {novo && (
        <Card className="mb-5 p-6">
          <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] items-end gap-4">
            <Campo label="NOME">
              <input className={inputCls} placeholder="Nome completo" value={nome} onChange={(e) => setNome(e.target.value)} />
            </Campo>
            <Campo label="E-MAIL">
              <input className={inputCls} type="email" placeholder="nome@exemplo.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Campo>
            <Campo label="NÍVEL DE ACESSO">
              <Select value={perfil} onChange={(v) => setPerfil(v as Perfil)} className="w-full">{niveis}</Select>
            </Campo>
            <Campo label="FILIAL">
              <Select value={filial} onChange={(v) => setFilial(v as Filial)} className="w-full">{filiais}</Select>
            </Campo>
            <Botao onClick={enviarConvite} disabled={pendente}>Enviar convite</Botao>
          </div>
        </Card>
      )}

      <Card className="mb-5">
        <CardHeader eyebrow={`${usuarios.length} ${usuarios.length === 1 ? "usuário" : "usuários"}`} title="Equipe" />
        <Grade
          className="mt-3"
          head={["Nome", "E-mail", "Nível de acesso", "Filial", "Situação", "Cadastro", ""]}
          rows={usuarios.map((u) =>
            editando === u.id
              ? [
                  <b key="n" className="font-semibold">{u.nome}</b>,
                  <span key="e" className="text-cinza">{u.email}</span>,
                  <Select key="p" value={ed.perfil} onChange={(v) => setEd({ ...ed, perfil: v as Perfil })}>{niveis}</Select>,
                  <Select key="f" value={ed.filial} onChange={(v) => setEd({ ...ed, filial: v as Filial })}>{filiais}</Select>,
                  <Select key="s" value={ed.ativo ? "1" : "0"} onChange={(v) => setEd({ ...ed, ativo: v === "1" })}>
                    <option value="1">Ativo</option>
                    <option value="0">Inativo</option>
                  </Select>,
                  <span key="c" className="text-cinza">{u.cadastro}</span>,
                  <span key="b" className="flex gap-2">
                    <Botao onClick={() => salvar(u.id)} disabled={pendente} className="!px-2.5 !py-1 !text-[13px]">Salvar</Botao>
                    <Botao variante="secundario" onClick={() => setEditando(null)} className="!px-2.5 !py-1 !text-[13px]">Cancelar</Botao>
                  </span>,
                ]
              : [
                  <b key="n" className="font-semibold">{u.nome}</b>,
                  <span key="e" className="text-cinza">{u.email}</span>,
                  PERFIS[u.perfil].nome,
                  u.filial,
                  <Badge key="s" tom={u.ativo ? "agua" : "ouro"}>{u.ativo ? "Ativo" : "Inativo"}</Badge>,
                  <span key="c" className="text-cinza">{u.cadastro}</span>,
                  <span key="b" className="flex gap-1">
                    <Botao variante="fantasma" onClick={() => editar(u)} className="!px-2 !py-1 !text-[13px]">Editar</Botao>
                    {u.convitePendente && u.ativo && (
                      <Botao variante="fantasma" onClick={() => reenviar(u)} disabled={pendente} className="!px-2 !py-1 !text-[13px]">Reenviar convite</Botao>
                    )}
                  </span>,
                ],
          )}
        />
      </Card>
    </>
  );
}
