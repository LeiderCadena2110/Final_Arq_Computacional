import { CSSProperties, useCallback, useEffect, useState } from "react";
import { apiFetch, borrarSesion, EVENTO_SESION_EXPIRADA, guardarSesion, leerSesion, Usuario } from "./api";
import Login from "./components/Login";
import PanelAdmin from "./components/PanelAdmin";
import PanelVendedor from "./components/PanelVendedor";

const estilos: Record<string, CSSProperties> = {
  barra: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "12px 24px",
    background: "#1e3a5f",
    color: "#fff",
    flexWrap: "wrap",
  },
  marca: { fontWeight: 700, fontSize: 18 },
  sub: { fontSize: 12, opacity: 0.8 },
  usuario: { display: "flex", alignItems: "center", gap: 12, fontSize: 14 },
  rol: { padding: "2px 8px", borderRadius: 999, background: "#ffffff22", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 },
  salir: { background: "transparent", border: "1px solid #ffffff88", color: "#fff", borderRadius: 6, padding: "6px 12px" },
  contenido: { maxWidth: 1280, margin: "0 auto", padding: 24 },
  cargando: { padding: 48, textAlign: "center", color: "#6b7280" },
};

export default function App() {
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [verificando, setVerificando] = useState<boolean>(true);
  const [aviso, setAviso] = useState<string | null>(null);

  const cerrarSesion = useCallback((mensaje?: string) => {
    borrarSesion();
    setUsuario(null);
    setAviso(mensaje ?? null);
  }, []);

  // Al cargar: si hay un JWT en localStorage, se valida contra el backend.
  useEffect(() => {
    const sesion = leerSesion();
    if (sesion === null) {
      setVerificando(false);
      return;
    }
    apiFetch<{ usuario: Usuario }>("/api/auth/perfil")
      .then((r) => setUsuario(r.usuario))
      .catch(() => cerrarSesion("Su sesión expiró. Ingrese de nuevo."))
      .finally(() => setVerificando(false));
  }, [cerrarSesion]);

  // Cualquier 401 de la API cierra la sesión.
  useEffect(() => {
    const alExpirar = (): void => cerrarSesion("Su sesión expiró. Ingrese de nuevo.");
    window.addEventListener(EVENTO_SESION_EXPIRADA, alExpirar);
    return () => window.removeEventListener(EVENTO_SESION_EXPIRADA, alExpirar);
  }, [cerrarSesion]);

  const alIngresar = (token: string, u: Usuario): void => {
    guardarSesion(token, u);
    setAviso(null);
    setUsuario(u);
  };

  if (verificando) return <div style={estilos.cargando}>Verificando sesión…</div>;

  if (usuario === null) return <Login onIngreso={alIngresar} aviso={aviso} />;

  return (
    <div>
      <header style={estilos.barra}>
        <div>
          <div style={estilos.marca}>Tienda UCC · Ventas</div>
          <div style={estilos.sub}>Proyecto final · Arquitectura Computacional</div>
        </div>
        <div style={estilos.usuario}>
          <span>{usuario.nombre}</span>
          <span style={estilos.rol}>{usuario.rol}</span>
          <button style={estilos.salir} onClick={() => cerrarSesion()}>
            Cerrar sesión
          </button>
        </div>
      </header>
      <main style={estilos.contenido}>
        {usuario.rol === "admin" ? <PanelAdmin /> : <PanelVendedor usuario={usuario} />}
      </main>
    </div>
  );
}
