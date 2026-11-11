import { CSSProperties, FormEvent, useState } from "react";
import { apiFetch, ErrorApi, RespuestaLogin, Usuario } from "../api";

interface Props {
  onIngreso: (token: string, usuario: Usuario) => void;
  aviso: string | null;
}

const estilos: Record<string, CSSProperties> = {
  fondo: { minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: "linear-gradient(135deg, #1e3a5f, #2f6690)" },
  tarjeta: { width: "100%", maxWidth: 380, background: "#fff", borderRadius: 12, padding: 32, boxShadow: "0 20px 40px #0003" },
  titulo: { margin: "0 0 4px", fontSize: 22 },
  sub: { margin: "0 0 24px", color: "#6b7280", fontSize: 14 },
  etiqueta: { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6, color: "#374151" },
  campo: { width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #d1d5db", marginBottom: 16 },
  boton: { width: "100%", padding: "11px 12px", borderRadius: 8, border: "none", background: "#1e3a5f", color: "#fff", fontWeight: 600 },
  error: { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 16 },
  aviso: { background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 16 },
  ayuda: { marginTop: 20, fontSize: 12, color: "#6b7280", lineHeight: 1.6 },
  atajo: { background: "none", border: "none", color: "#2f6690", padding: 0, textDecoration: "underline", fontSize: 12 },
};

export default function Login({ onIngreso, aviso }: Props) {
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [enviando, setEnviando] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const enviar = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const r = await apiFetch<RespuestaLogin>("/api/auth/login", {
        metodo: "POST",
        cuerpo: { email, password },
        autenticado: false,
      });
      onIngreso(r.token, r.usuario); // App guarda el JWT en localStorage
    } catch (err) {
      setError(err instanceof ErrorApi ? err.message : "Error inesperado al ingresar");
    } finally {
      setEnviando(false);
    }
  };

  const rellenar = (correo: string, clave: string): void => {
    setEmail(correo);
    setPassword(clave);
  };

  return (
    <div style={estilos.fondo}>
      <form style={estilos.tarjeta} onSubmit={enviar}>
        <h1 style={estilos.titulo}>Ingresar</h1>
        <p style={estilos.sub}>Sistema de ventas · UCC Pasto</p>

        {aviso !== null && <div style={estilos.aviso}>{aviso}</div>}
        {error !== null && <div style={estilos.error}>{error}</div>}

        <label style={estilos.etiqueta} htmlFor="email">Correo</label>
        <input
          id="email"
          style={estilos.campo}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <label style={estilos.etiqueta} htmlFor="password">Contraseña</label>
        <input
          id="password"
          style={estilos.campo}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        <button style={estilos.boton} type="submit" disabled={enviando}>
          {enviando ? "Verificando…" : "Ingresar"}
        </button>

        <div style={estilos.ayuda}>
          Usuarios de prueba:{" "}
          <button type="button" style={estilos.atajo} onClick={() => rellenar("vendedor@tienda.local", "Vendedor2026*")}>
            vendedor
          </button>{" "}
          ·{" "}
          <button type="button" style={estilos.atajo} onClick={() => rellenar("admin@tienda.local", "Admin2026*")}>
            admin
          </button>
        </div>
      </form>
    </div>
  );
}
