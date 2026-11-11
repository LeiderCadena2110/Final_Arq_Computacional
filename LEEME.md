# Proyecto final · Arquitectura Computacional · UCC Pasto

Sistema de ventas (Node.js + Express + TypeScript, PostgreSQL, React + Vite) usado para medir **dónde espera la aplicación** bajo carga sostenida y compararla en tres entornos.

| Archivo | Qué es |
|---|---|
| `base_de_datos.sql` | Esquema + seed (admin, vendedor, 6 categorías, 500 productos con 1.000.000 de unidades) |
| `script_carga_locust.py` | Carga sostenida (≥ 5 min): 10 % login, 60 % catálogo, 30 % compras |
| `medir_recursos.sh` | Captura vmstat, mpstat, pidstat, iostat, sar, docker stats y cpu.stat mientras corre la carga |
| `informe_tecnico.md` | Informe (los datos marcados ILUSTRATIVO deben reemplazarse por mediciones propias) |
| `guion_diapositivas.md` | Sustentación de 7 minutos y respuestas a las 4 preguntas |
| `proyecto/` | Backend, frontend y `docker-compose.yml` del entorno con límites |
| `resultados/validacion_vm_desarrollo/` | Una corrida real de ejemplo (formato de los datos crudos) |

## Puesta en marcha

```bash
# 1. Base de datos (PostgreSQL 14+)
createdb tienda_carga
psql -d tienda_carga -f base_de_datos.sql

# 2. API (Node.js 20+)  → http://localhost:3000
cd proyecto/backend
npm install && npm run build
PGUSER=postgres PGPASSWORD=postgres JWT_SECRET=un-secreto-largo node dist/server.js

# 3. Frontend → http://localhost:5173
cd proyecto/frontend
npm install && npm run dev

# 4. Carga (desde OTRA máquina)
pip install "locust>=2.32"
locust -f script_carga_locust.py --headless --host http://<ip-servidor>:3000 --csv resultados/local_corrida1

# 5. Medición (en el servidor, al terminar la rampa de 60 s)
sudo apt install -y sysstat
./medir_recursos.sh local_corrida1 300

# Entorno contenedor (0,5 vCPU / 512 MB)
cd proyecto && docker compose up -d --build
./medir_recursos.sh docker_corrida1 300 tienda-api
```

Usuarios: `vendedor@tienda.local / Vendedor2026*` · `admin@tienda.local / Admin2026*`

Endpoints: `POST /api/auth/login` · `GET /api/auth/perfil` · `GET /api/productos?categoria=<slug|id>&busqueda=&limite=&pagina=` · `GET /api/productos/categorias` · `GET /api/productos/inventario` (admin) · `GET /api/productos/:id` · `POST /api/ventas` · `GET /api/ventas` (admin) · `GET /api/ventas/resumen` (admin) · `GET /api/health` · `GET /api/metricas`
