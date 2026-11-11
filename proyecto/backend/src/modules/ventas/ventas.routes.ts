import { Router } from "express";
import { requerirRol, verificarToken } from "../auth/auth.controller";
import { crearVenta, listarVentas, resumenVentas } from "./ventas.controller";

const router = Router();

router.use(verificarToken);

router.post("/", requerirRol("vendedor", "admin"), crearVenta);
router.get("/", requerirRol("admin"), listarVentas);
router.get("/resumen", requerirRol("admin"), resumenVentas);

export default router;
