/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// Estilos base embebidos (sin dependencias de CSS externas).
const estilosGlobales = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body, #root { margin: 0; min-height: 100%; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #f3f5f9;
    color: #1f2937;
    -webkit-font-smoothing: antialiased;
  }
  button { font: inherit; cursor: pointer; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  input, select { font: inherit; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
  th { background: #f9fafb; font-weight: 600; color: #374151; position: sticky; top: 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
`;

const estilo = document.createElement("style");
estilo.textContent = estilosGlobales;
document.head.appendChild(estilo);

const raiz = document.getElementById("root");
if (raiz === null) throw new Error("No se encontró el elemento #root en index.html");

createRoot(raiz).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
