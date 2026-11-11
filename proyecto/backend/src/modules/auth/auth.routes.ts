import { Router } from "express";
import { login, perfil, verificarToken } from "./auth.controller";

const router = Router();

// Pública: entrega el JWT con el rol del usuario.
router.post("/login", login);

// Protegida: devuelve el usuario contenido en el token (sirve para que el
// frontend valide una sesión guardada en localStorage).
router.get("/perfil", verificarToken, perfil);

export default router;
