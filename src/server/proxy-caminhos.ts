// Exclusões do proxy. A mesma regra vale no `config.matcher` (literal, exigido pelo Next)
// e em `deveProteger`, usada pelo próprio proxy como segunda camada.
export const MATCHER_PROXY =
  "/((?!_next/static|_next/image|favicon\\.ico$|logo-eclak\\.png$|login(?:/|$)|auth/confirmar(?:/|$)).*)";

const EXCLUIDOS = /^\/(?:_next\/static|_next\/image|favicon\.ico$|logo-eclak\.png$|login(?:\/|$)|auth\/confirmar(?:\/|$))/;

export function deveProteger(pathname: string): boolean {
  return !EXCLUIDOS.test(pathname);
}
