import { Router } from "express";
import { requerirRol, verificarToken } from "../auth/auth.controller";
import { inventario, listarCategorias, listarProductos, obtenerProducto } from "./productos.controller";

const router = Router();

// Todas las rutas de productos verifican el JWT (costo de CPU por petición).
router.use(verificarToken);

router.get("/", requerirRol("admin", "vendedor"), listarProductos);
router.get("/categorias", requerirRol("admin", "vendedor"), listarCategorias);
router.get("/inventario", requerirRol("admin"), inventario);
router.get("/:id", requerirRol("admin", "vendedor"), obtenerProducto);

export default router;
