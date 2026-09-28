import express from "express";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  herramientas,
  confirmarPendiente,
  obtenerPendiente,
  type Contexto,
} from "./tools/oc.js";
import { OpenAIAdapter } from "./llm/openai.js";
import type { Mensaje, LlmAdapter } from "./llm/adapter.js";

const app = express();
const directory = process.cwd();
const modelo: LlmAdapter = new OpenAIAdapter();

function limite(nombre: string, defecto: number): number {
  const valor = Number(process.env[nombre] ?? defecto);
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new Error(`Configuración inválida: ${nombre}`);
  }
  return valor;
}

const maxIteraciones = limite("MAX_ITERATIONS", 12);
const maxTokens = limite("MAX_SESSION_TOKENS", 120000);
let presupuestoGlobal = limite("MAX_GLOBAL_TOKENS", 500000);

type Evento = { nombre: string; argumentos: unknown; resultado: unknown };
type Sesion = {
  mensajes: Mensaje[];
  eventos: Evento[];
  tokens: number;
  ocupada: boolean;
};

const sesiones = new Map<string, Sesion>();

const instrucciones = await readFile(
  path.join(directory, "agent", "prompt.md"), "utf-8"
);
const conocimiento = await readFile(
  path.join(directory, "src", "knowledge", "ordenes-compra.md"), "utf-8"
);

const definiciones = Object.entries(herramientas).map(([name, herramienta]) => ({
  name,
  description: herramienta.description,
  parameters: z.toJSONSchema(z.object(herramienta.args)),
}));

async function ejecutar(nombre: string, entrada: unknown, ctx: Contexto) {
  // Cada rama conserva el tipo de argumentos correspondiente.
  switch (nombre) {
    case "oc_leer_paquete":
      return herramientas.oc_leer_paquete.execute(
        z.object(herramientas.oc_leer_paquete.args).parse(entrada), ctx);
    case "oc_validar":
      return herramientas.oc_validar.execute(
        z.object(herramientas.oc_validar.args).parse(entrada), ctx);
    case "oc_construir_payload":
      return herramientas.oc_construir_payload.execute(
        z.object(herramientas.oc_construir_payload.args).parse(entrada), ctx);
    case "oc_generar_evidencia":
      return herramientas.oc_generar_evidencia.execute(
        z.object(herramientas.oc_generar_evidencia.args).parse(entrada), ctx);
    case "oc_crear":
      return herramientas.oc_crear.execute(
        z.object(herramientas.oc_crear.args).parse(entrada), ctx);
    default:
      throw new Error("Herramienta no permitida");
  }
}

app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(directory, "web")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    provider: "openai",
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  });
});

app.get("/api/sessions/:id", (req, res) => {
  const sesion = sesiones.get(String(req.params.id));
  if (!sesion) {
    res.status(404).json({ error: "Sesión no encontrada" });
    return;
  }
  res.json({ historial: sesion.mensajes, toolCalls: sesion.eventos });
});

app.post("/api/chat", async (req, res) => {
  const entrada = z.object({
    sessionId: z.string().uuid().optional(),
    message: z.string().trim().min(1).max(4000),
  }).safeParse(req.body);

  if (!entrada.success) {
    res.status(400).json({ reply: "Mensaje o sesión inválidos" });
    return;
  }

  const sessionId = entrada.data.sessionId || randomUUID();
  let sesion = sesiones.get(sessionId);
  if (!sesion) {
    sesion = { mensajes: [], eventos: [], tokens: 0, ocupada: false };
    sesiones.set(sessionId, sesion);
  }
  if (sesion.ocupada) {
    res.status(409).json({ reply: "Espera a que termine la solicitud anterior" });
    return;
  }

  sesion.ocupada = true;
  const eventos: Evento[] = [];
  let reply = "Se alcanzó el límite de iteraciones. Revisa las herramientas ejecutadas.";
  let contextoConfirmacion = "";

  try {
    const mensaje = entrada.data.message;
    if (/^confirmo[.!]?$/i.test(mensaje)) {
      const caso = confirmarPendiente(sessionId);
      contextoConfirmacion = caso
        ? `El backend registró confirmación humana para ${caso}.`
        : "No existe una confirmación pendiente para esta sesión.";
    }

    sesion.mensajes.push({ role: "user", content: mensaje });

    for (let paso = 0; paso < maxIteraciones; paso++) {
      const prompt = `${instrucciones}\n${conocimiento}\n${contextoConfirmacion}`;

      // Reserva conservadora por bytes de entrada + salida máxima.
      const reserva = Buffer.byteLength(
        JSON.stringify([prompt, sesion.mensajes, definiciones]), "utf-8"
      ) + 4096;

      if (sesion.tokens + reserva > maxTokens || presupuestoGlobal < reserva) {
        reply = "Se alcanzó el presupuesto configurado. No se harán más llamadas al modelo.";
        break;
      }

      // Se descuenta antes de llamar: también limita sesiones simultáneas.
      presupuestoGlobal -= reserva;
      sesion.tokens += reserva;

      const respuesta = await modelo.enviar(prompt, sesion.mensajes, definiciones);
      //----- 
      if (!respuesta.llamadas.length) {
        // Solo completamos automáticamente una petición explícita de procesar.
        const casoSolicitado = mensaje.match(
            /^procesa\s+(?:la\s+solicitud\s+)?["']?(sol-\d{3})\b/i
        )?.[1];

        const pideEsperar =
            /\b(no|espera|antes|hasta|solo|solamente|revisa|mu[eé]stra|confirmaci[oó]n)\b/i
            .test(mensaje);

        const construccion = [...eventos].reverse().find((evento) => {
            const args = z.object({ caso: z.string() }).safeParse(evento.argumentos);
            return evento.nombre === "oc_construir_payload" &&
            args.success && args.data.caso === casoSolicitado;
        });

        const preparada = z.object({
            ok: z.literal(true),
            data: z.object({
            payload: z.record(z.string(), z.unknown()),
            validacion: z.object({
                apta: z.literal(true),
                confirmaciones: z.array(z.unknown()).length(0),
            }),
            }),
        }).safeParse(construccion?.resultado);

        const intentoCrear = eventos.some(
            (evento) => evento.nombre === "oc_crear"
        );

        if (
            casoSolicitado &&
            !pideEsperar &&
            preparada.success &&
            !intentoCrear &&
            !obtenerPendiente(sessionId)
        ) {
            const argumentos = {
            caso: casoSolicitado,
            payload: preparada.data.data.payload,
            confirmado: false,
            };

            // La herramienta vuelve a validar todos los controles.
            const salida = await ejecutar(
            "oc_crear", argumentos, { directory, sessionId }
            );

            const resultado: unknown = JSON.parse(salida);
            const evento = {
            nombre: "oc_crear",
            argumentos,
            resultado,
            };

            eventos.push(evento);
            sesion.eventos.push(evento);

            await mkdir(path.join(directory, "out"), { recursive: true });
            await appendFile(
            path.join(directory, "out", "log.jsonl"),
            JSON.stringify({
                sessionId,
                origen: "backend_flujo_normal",
                ...evento,
                ts: new Date().toISOString(),
            }) + "\n"
            );

            reply = "Resultado de procesar la solicitud:\n" +
            JSON.stringify(resultado, null, 2);
        } else {
            reply = respuesta.texto ||
            "No recibí una respuesta de texto. Puedes reintentar.";
        }
        break;
      }
      //----- 
      sesion.mensajes.push(...respuesta.llamadas);

      for (const llamada of respuesta.llamadas) {
        let argumentos: unknown = null;
        let salida: string;

        try {
          argumentos = JSON.parse(llamada.arguments);
          salida = await ejecutar(llamada.name, argumentos, { directory, sessionId });
        } catch (error) {
          salida = JSON.stringify({
            ok: false,
            error: error instanceof z.ZodError
              ? "Argumentos inválidos para la herramienta"
              : error instanceof Error ? error.message : "Error de herramienta",
          });
        }

        sesion.mensajes.push({
          type: "function_call_output",
          call_id: llamada.call_id,
          output: salida,
        });

        const evento = {
          nombre: llamada.name,
          argumentos,
          resultado: JSON.parse(salida) as unknown,
        };
        eventos.push(evento);
        sesion.eventos.push(evento);

        await mkdir(path.join(directory, "out"), { recursive: true });
        await appendFile(
          path.join(directory, "out", "log.jsonl"),
          JSON.stringify({ sessionId, ...evento, ts: new Date().toISOString() }) + "\n"
        );
      }
    }
  } catch {
    reply = "No fue posible completar el turno. Revisa la conexión, permisos de la clave o saldo del proveedor. Puedes reintentar.";
  } finally {
    sesion.ocupada = false;
  }

  sesion.mensajes.push({ role: "assistant", content: reply });
  res.json({
    sessionId,
    reply,
    toolCalls: eventos,
    needsConfirmation: Boolean(obtenerPendiente(sessionId)),
  });
});

const puerto = Number(process.env.PORT || 3000);
app.listen(puerto, process.env.HOST || "127.0.0.1", () => {
  console.log(`Servidor listo en puerto ${puerto}`);
});